import { VMError } from "../errors.js";
import type { ImagePreparationReport } from "../protocol/image-preparation.js";

export interface ImagePreparationProgress extends ImagePreparationReport { readonly completedObjects:number }
interface Consumer { readonly progress?: (progress:ImagePreparationProgress)=>void; readonly background:boolean; readonly resolve:()=>void; readonly reject:(error:unknown)=>void; readonly detach:()=>void }
interface Job { readonly controller:AbortController; readonly consumers:Set<Consumer>; done:Promise<void> }

/** One image acquisition can serve background and foreground consumers without sharing cancellation. */
export class RootfsImagePreparation {
  readonly #jobs=new Map<string,Job>();
  async prepare(key:string,options:{readonly background?:boolean;readonly signal?:AbortSignal;readonly progress?:(progress:ImagePreparationProgress)=>void},run:(signal:AbortSignal,foreground:()=>boolean,progress:(progress:ImagePreparationProgress)=>void)=>Promise<void>):Promise<void> {
    const signal=options.signal;if(signal?.aborted===true)throw cancelled();
    let job=this.#jobs.get(key);
    if(job?.controller.signal.aborted===true){await job.done.catch(()=>{});return this.prepare(key,options,run);}
    if(job===undefined) {
      job={controller:new AbortController(),consumers:new Set(),done:Promise.resolve()};this.#jobs.set(key,job);
      const created=job;
      created.done=Promise.resolve().then(()=>run(created.controller.signal,()=>[...created.consumers].some(consumer=>!consumer.background),progress=>{for(const consumer of created.consumers)consumer.progress?.(progress);})).then(
        ()=>{for(const consumer of created.consumers){consumer.detach();consumer.resolve();}},
        (error:unknown)=>{for(const consumer of created.consumers){consumer.detach();consumer.reject(error);}},
      ).finally(()=>{created.consumers.clear();if(this.#jobs.get(key)===created)this.#jobs.delete(key);});
    }
    const shared=job;
    return new Promise<void>((resolve,reject)=>{
      const cancel=()=>{shared.consumers.delete(consumer);consumer.detach();reject(cancelled());if(shared.consumers.size===0)shared.controller.abort();};
      const consumer:Consumer={...(options.progress===undefined?{}:{progress:options.progress}),background:options.background===true,resolve,reject,detach:()=>signal?.removeEventListener("abort",cancel)};
      shared.consumers.add(consumer);signal?.addEventListener("abort",cancel,{once:true});if(signal?.aborted===true)cancel();
    });
  }
  async drain():Promise<void>{await Promise.allSettled([...this.#jobs.values()].map(job=>job.done));}
}
function cancelled():VMError{return new VMError("ABORTED","Image preparation consumer cancelled");}
