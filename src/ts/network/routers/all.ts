import {Router} from "./baseRouter"
import {router as PingPongRouter} from "./pingPong"
import {router as EntityRouter} from "./entity"
import {router as EncounterRouter} from "./encounter"
import {router as RollRouter} from "./roll"
import {router as SearchRouter} from "./search"
import {router as StructureRouter} from "./structure"
import {router as MacroRouter} from "./macro"
import {router as UtilityRouter} from "./utility"
import {router as FileSystemRouter} from "./fileSystem"
import {router as Dnd5eRouter} from "./dnd5e"
import {router as SceneRouter} from "./scene"
import {router as CanvasRouter} from "./canvas"
import {router as ChatRouter} from "./chat"
import {router as EffectsRouter} from "./effects"
import {router as SheetScreenshotRouter} from "./sheetScreenshot"
import {router as InteractiveSessionRouter} from "./interactiveSession"
import {router as PlaylistRouter} from "./playlist"
import {router as SceneImageRouter} from "./sceneImage"
import {router as UserRouter} from "./user"
import {router as TransferRouter} from "./transfer"
import {router as RemoteResponseRouter} from "./remoteResponse"

export const routers: Router[] = [
    PingPongRouter,
    EntityRouter,
    EncounterRouter,
    RollRouter,
    SearchRouter,
    StructureRouter,
    MacroRouter,
    UtilityRouter,
    FileSystemRouter,
    Dnd5eRouter,
    SceneRouter,
    CanvasRouter,
    ChatRouter,
    EffectsRouter,
    SheetScreenshotRouter,
    InteractiveSessionRouter,
    PlaylistRouter,
    SceneImageRouter,
    UserRouter,
    TransferRouter,
    RemoteResponseRouter
]
