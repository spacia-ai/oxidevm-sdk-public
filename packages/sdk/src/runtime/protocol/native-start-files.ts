import {exactKeys,record} from "../decode.js";
import {decodeSnapshotId} from "./snapshots.js";
export interface SelectedNativeFiles {readonly sourceId:string;readonly replaced?:string}
export function decodeSelectedNativeFiles(value:unknown):SelectedNativeFiles {
 const input=record(value,"selected native files");exactKeys(input,["sourceId"],["replaced"]);
 return {sourceId:decodeSnapshotId(input["sourceId"]),...(input["replaced"]===undefined?{}:{replaced:decodeSnapshotId(input["replaced"])})};
}
