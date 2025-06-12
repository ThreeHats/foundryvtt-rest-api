import {Router} from "./baseRouter"
import {router as PingPongRouter} from "./pingPong"
import {router as EntityRouter} from "./entity"
import {router as EncounterRouter} from "./encounter"
import {router as RollRouter} from "./roll"
import {router as SearchRouter} from "./search"
import {router as StructureRouter} from "./structure"
import {router as SheetRouter} from "./sheet"
import {router as MacroRouter} from "./macro"
import {router as UtilityRouter} from "./utility"
import {router as FileSystemRouter} from "./fileSystem"

export const routers: Router[] = [
    PingPongRouter,
    EntityRouter,
    EncounterRouter,
    RollRouter,
    SearchRouter,
    StructureRouter,
    SheetRouter,
    MacroRouter,
    UtilityRouter,
    FileSystemRouter
]
