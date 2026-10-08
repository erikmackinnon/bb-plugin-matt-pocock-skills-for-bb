// Keep realtime constants free of the server SDK for the app bundle.
import { mirrorConfig } from "../mirror.config.ts";

export const STATE_CHANGED = mirrorConfig.identity.eventChannel;
