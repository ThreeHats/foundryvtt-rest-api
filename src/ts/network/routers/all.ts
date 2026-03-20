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
import {router as Dnd5eRouter} from "./dnd5e"
import {router as SceneRouter} from "./scene"
import {router as CanvasRouter} from "./canvas"
import {router as ChatRouter} from "./chat"

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
    FileSystemRouter,
    Dnd5eRouter,
    SceneRouter,
    CanvasRouter,
    ChatRouter
]
