declare module '*.css';
declare module '*.scss';
declare module '*.png' {
  const src: string;
  export default src;
}
