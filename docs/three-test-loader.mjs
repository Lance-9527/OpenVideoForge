const three = new URL('../assets/three.module.js', import.meta.url).href;
export async function resolve(specifier, context, next) {
 if(specifier==='three')return {url:three,shortCircuit:true};
 return next(specifier,context);
}
