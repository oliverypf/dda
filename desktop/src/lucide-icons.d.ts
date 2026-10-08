type DdaIconNode = [tag: string, attrs: Record<string, string>][];

declare module 'lucide/dist/esm/icons/*.mjs' {
  const icon: DdaIconNode;
  export default icon;
}

declare module 'lucide/dist/esm/replaceElement.mjs' {
  const replaceElement: (
    element: Element,
    options: {
      nameAttr: string;
      icons: Record<string, DdaIconNode>;
      attrs: Record<string, string | number>;
    }
  ) => unknown;
  export default replaceElement;
}
