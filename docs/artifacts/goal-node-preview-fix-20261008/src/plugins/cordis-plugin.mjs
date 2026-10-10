export const cordisPlugin = (apply, name, inject = []) => {
  Object.defineProperty(apply, 'name', { value: name, configurable: true });
  Object.defineProperty(apply, 'inject', { value: inject, configurable: true });
  return apply;
};
