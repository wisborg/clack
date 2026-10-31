// The build imports CSS files as their text (see tools/internal/bundle).
declare module "*.css" {
  const text: string;
  export default text;
}
