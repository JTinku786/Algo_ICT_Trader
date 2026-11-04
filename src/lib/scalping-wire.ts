/** Lossless wire decoding; duplicated reference evidence shares a single object. */
export function decodeScalpingResponse<T>(input:T):T {
 const wire=input as T & {encoding?:string;nodes?:unknown[][];root?:{$:number};meta?:Record<string,unknown>};
 if(wire.encoding!=="scalping-object-graph-v1")return input;
 if(!Array.isArray(wire.nodes)||!wire.root)throw new Error("Invalid Scalping Labs evidence graph.");
 const decoded:unknown[]=[];
 const resolve=(v:unknown):unknown=>{
  if(v&&typeof v==="object"){
   const index=(v as {$:number}).$;
   if(!Number.isInteger(index)||index<0||index>=decoded.length)throw new Error("Invalid evidence reference.");
   return decoded[index];
  }
  return v;
 };
 for(const [kind,payload] of wire.nodes){
  if(kind==="a"&&Array.isArray(payload))decoded.push(payload.map(resolve));
  else if(kind==="o"&&payload&&typeof payload==="object")decoded.push(Object.fromEntries(Object.entries(payload).map(([k,v])=>[k,resolve(v)])));
  else throw new Error("Invalid evidence node.");
 }
 const root=resolve(wire.root);
 return {...root as Record<string,unknown>,...wire.meta} as T;
}
