// Bun's bundler turns a side-effect CSS import into an emitted stylesheet.
// TypeScript has no idea what a .css module is, so tell it.
declare module '*.css';
