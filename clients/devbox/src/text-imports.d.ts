/**
 * Bun's text loader has declarations for `*.txt`/`*.toml`/… (bun-types/extensions.d.ts)
 * but not for `*.sh` or `*.py`: `account.ts` embeds the swap engine and `omp-pin.ts` the
 * omp pin helper that way. Declared with a
 * default export (not `export =`) because this project does not enable esModuleInterop.
 */
declare module "*.sh" {
  const text: string;
  export default text;
}

declare module "*.py" {
  const text: string;
  export default text;
}
