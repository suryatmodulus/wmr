import { resolve, dirname, sep, posix } from 'path';
import { promises as fs } from 'fs';
import chokidar from 'chokidar';
import mime from 'mime/lite.js';
import htmPlugin from './plugins/htm-plugin.js';
import sucrasePlugin from './plugins/sucrase-plugin.js';
import wmrPlugin, { getWmrClient } from './plugins/wmr/plugin.js';
import wmrStylesPlugin, { modularizeCss } from './plugins/wmr/styles-plugin.js';
import { createPluginContainer } from './lib/rollup-plugin-container.js';
import { transformImports } from './lib/transform-imports.js';
import aliasesPlugin from './plugins/aliases-plugin.js';

/**
 * In-memory cache of files that have been generated and written to .dist/
 * @type {Map<string, string | Buffer>}
 */
const WRITE_CACHE = new Map();

/**
 * @param {object} [options]
 * @param {string} [options.cwd]
 * @param {string} [options.root] cwd without ./public suffix
 * @param {string} [options.out = '.dist']
 * @param {string} [options.distDir] if set, ignores watch events within this directory
 * @param {boolean} [options.sourcemap]
 * @param {Record<string, string>} [options.aliases]
 * @param {boolean} [options.profile] Enable bundler performance profiling
 * @param {(error: Error & { clientMessage?: string })=>void} [options.onError]
 * @param {(event: { changes: string[], duration: number })=>void} [options.onChange]
 * @returns {import('polka').Middleware}
 */
export default function wmrMiddleware({ cwd, root, out = '.dist', distDir = 'dist', aliases, onError, onChange } = {}) {
	cwd = resolve(process.cwd(), cwd || '.');
	distDir = resolve(dirname(out), distDir);

	root = root || cwd;

	const NonRollup = createPluginContainer(
		[
			sucrasePlugin({
				typescript: true,
				sourcemap: false,
				production: false
			}),
			aliasesPlugin({ aliases }),
			htmPlugin(),
			wmrPlugin({ hot: true })
		],
		{ cwd: root }
	);

	NonRollup.buildStart();

	let useFsEvents = false;
	try {
		eval('require')('fsevents');
		useFsEvents = true;
	} catch (e) {}

	const watcher = chokidar.watch([cwd, resolve(root, 'package.json')], {
		cwd,
		disableGlobbing: true,
		ignored: [/(^|[/\\])(node_modules|\.git|\.DS_Store)([/\\]|$)/, resolve(cwd, out), resolve(cwd, distDir)],
		useFsEvents
	});
	const pendingChanges = new Set();

	function flushChanges() {
		onChange({ changes: Array.from(pendingChanges), duration: 0 });
		pendingChanges.clear();
	}
	watcher.on('change', filename => {
		NonRollup.watchChange(resolve(cwd, filename));
		filename = filename.split(sep).join(posix.sep);
		if (!pendingChanges.size) setTimeout(flushChanges, 60);
		pendingChanges.add('/' + filename);
		// Delete file from the in-memory cache:
		WRITE_CACHE.delete(filename);
		// Delete any generated CSS Modules mapping modules:
		if (/\.module\.css$/.test(filename)) WRITE_CACHE.delete(filename + '.js');
	});

	/**
	 * @param {IncomingMessage} req
	 * @param {ServerResponse} res
	 * @param {() => void} next
	 */
	return async (req, res, next) => {
		// @ts-ignore
		const path = posix.normalize(req.path);

		if (path.startsWith('/@npm/')) {
			return next();
		}

		let file = posix.join(cwd, path);

		// As of the time of this writing TS doesn't support import paths ending with
		// ".tsx" or ".ts". We work around this by appending the extension when we
		// know that the import came from a ts/tsx file.
		// See #71
		if (/\.([tj]sx?)$/.test(req.headers.referer || '') && !/\.\w{2,}$/.test(path)) {
			const isCached = file => WRITE_CACHE.has(posix.relative(cwd, file).replace(/^\.\//, ''));
			const isFile = file => fs.stat(file).then(s => s.isFile()).catch(() => false);

			// check in-memory cache first, then check the disk:
			if (isCached(file + '.tsx')) file += '.tsx';
			else if (isCached(file + '.ts')) file += '.ts';
			else if (await isFile(file + '.tsx')) file += '.tsx';
			else if (await isFile(file + '.ts')) file += '.ts';
		}

		// Rollup-style CWD-relative path "id"
		const id = posix.relative(cwd, file).replace(/^\.\//, '');

		const type = mime.getType(file);
		if (type) res.setHeader('content-type', type);

		const ctx = { req, res, id, file, path, cwd, out, NonRollup, next };

		let transform;
		if (path === '/_wmr.js') {
			transform = getWmrClient.bind(null);
		} else if (/\.css\.js$/.test(file)) {
			transform = TRANSFORMS.cssModule;
		} else if (/\.([mc]js|[tj]sx?)$/.test(file)) {
			transform = TRANSFORMS.js;
		} else if (/\.(css|s[ac]ss)$/.test(file)) {
			transform = TRANSFORMS.css;
		} else {
			transform = TRANSFORMS.generic;
		}

		try {
			const start = Date.now();
			const result = await transform(ctx);

			// return false to skip handling:
			if (result === false) return next();

			// return a value to use it as the response:
			if (result != null) {
				const time = Date.now() - start;
				// console.log(result);
				res.writeHead(200, {
					'content-length': result.length,
					'server-timing': `${transform.name};dur=${time}`
				});
				res.end(result);
			}
		} catch (e) {
			// `throw null` also skips handling
			if (e == null) return next();

			onError(e);
			next(e);
		}
	};
}

export const TRANSFORMS = {
	// Handle individual JavaScript modules
	async js({ id, file, res, cwd, out, NonRollup }) {
		res.setHeader('content-type', 'application/javascript');

		if (WRITE_CACHE.has(id)) return WRITE_CACHE.get(id);

		let code = await fs.readFile(resolve(cwd, file), 'utf-8');

		code = await NonRollup.transform(code, id);

		code = await transformImports(code, id, {
			resolveImportMeta(property) {
				return NonRollup.resolveImportMeta(property);
			},
			resolveId(spec, importer) {
				if (spec === 'wmr') return '/_wmr.js';

				// foo.css --> foo.css.js (import of CSS Modules proxy module)
				if (spec.endsWith('.css')) spec += '.js';

				if (!/^\.?\.?\//.test(spec)) {
					spec = `/@npm/${spec}`;
				}
				return spec;
			}
		});

		writeCacheFile(out, id, code);

		return code;
	},

	// Handles "CSS Modules" proxy modules (style.module.css.js)
	async cssModule({ id, file, cwd, out, res }) {
		res.setHeader('content-type', 'application/javascript');

		// Cache the generated mapping/proxy module with a .js extension (the CSS itself is also cached)
		if (WRITE_CACHE.has(id)) return WRITE_CACHE.get(id);

		file = file.replace(/\.js$/, '');

		// We create a plugin container for each request to prevent asset referenceId clashes
		const container = createPluginContainer(
			[wmrPlugin({ hot: true }), wmrStylesPlugin({ cwd, hot: true, fullPath: true })],
			{
				cwd,
				output: {
					dir: out,
					assetFileNames: '[name][extname]'
				},
				writeFile(filename, source) {
					writeCacheFile(out, filename, source);
				}
			}
		);

		const result = await container.load(file);

		let code = typeof result === 'string' ? result : result && result.code;

		code = await container.transform(code, id);

		code = await transformImports(code, id, {
			resolveImportMeta(property) {
				return container.resolveImportMeta(property);
			},
			resolveId(spec) {
				if (spec === 'wmr') return '/_wmr.js';
				console.warn('unresolved specifier: ', spec);
			}
		});

		writeCacheFile(out, id, code);

		return code;
	},

	// Handles CSS Modules (the actual CSS)
	async css({ id, path, file, cwd, out }) {
		if (!/\.module\.css$/.test(path)) throw null;

		if (WRITE_CACHE.has(id)) return WRITE_CACHE.get(id);

		let code = await fs.readFile(resolve(cwd, file), 'utf-8');

		code = modularizeCss(code, id);

		// const plugin = wmrStylesPlugin({ cwd, hot: false, fullPath: true });
		// let code;
		// const context = {
		// 	emitFile(asset) {
		// 		code = asset.source;
		// 	}
		// };
		// await plugin.load.call(context, file);

		writeCacheFile(out, id, code);

		return code;
	},

	// Falls through to sirv
	generic() {
		return false;
		// return new Promise((resolve, reject) => {
		// 	if (file.endsWith('/') || !file.match(/[^/]\.[a-z0-9]+$/gi)) {
		// 		file = file.replace(/\/$/, '') + '/index.html';
		// 	}
		// 	const fr = createReadStream(file);
		// 	// fr.once('data', () => res.writeHead(200));
		// 	fr.once('data', () => resolve());
		// 	fr.on('error', reject);
		// 	fr.pipe(res);
		// });
	}
};

/**
 * Write a file to a directory, ensuring any nested paths exist
 * @param {string} rootDir
 * @param {string} fileName
 * @param {string|Buffer} data
 */
async function writeCacheFile(rootDir, fileName, data) {
	WRITE_CACHE.set(fileName, data);
	const filePath = resolve(rootDir, fileName);
	if (dirname(filePath) !== rootDir) {
		await fs.mkdir(dirname(filePath), { recursive: true });
	}
	await fs.writeFile(filePath, data);
}
