/**
 * Bun's text loader has declarations for `*.txt`/`*.toml`/… (bun-types/extensions.d.ts)
 * but not for `*.sh`, and `account.ts` embeds the swap engine that way. Declared with a
 * default export (not `export =`) because this project does not enable esModuleInterop.
 */
declare module "*.sh" {
  const text: string;
  export default text;
}
