// The instance-side scripts (remote/*.sh) are bundled as text: esbuild's text loader in sst.config.ts, a plugin in
// vitest.config.ts.
declare module "*.sh" {
  const script: string;
  export default script;
}
