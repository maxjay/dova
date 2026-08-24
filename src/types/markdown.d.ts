/** Markdown imported as a string — see tsup.config.ts's `loader`. */
declare module '*.md' {
  const content: string;
  export default content;
}
