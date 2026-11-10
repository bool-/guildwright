/**
 * A fixture module that throws AT IMPORT. Read by `src/loader.test.ts` only.
 *
 * This is the failure `defineModule` cannot catch, because the throw happens before its
 * `install` closure exists. The loader has to catch it around the dynamic `import()` itself -
 * and `MODULES_DISABLE=explode` has to be honoured BEFORE that import, or the operator's
 * escape hatch does not work for the one module that most needs escaping.
 *
 * `export {}` is what makes this file a module rather than a script; nothing below the throw
 * ever runs.
 */

export {};

throw new Error('fixture explode: this module throws at import on purpose');
