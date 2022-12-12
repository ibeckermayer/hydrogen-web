import { RoomEventType } from "../net/types/roomEvents";
import { ClientEventWithoutRoomID } from "../net/types/sync";
import { Room, Options as RoomOptions } from "./Room";

/**
 * Space is technically just a special type of Room per matrix spec definitions
 */
export class Space extends Room {
  constructor(options: RoomOptions) {
    super({...options, isSpace: true})
  }
}

export function isSpaceCreateEvent(event: ClientEventWithoutRoomID): boolean {
  return event.type === RoomEventType.Create && event.content.type === "m.space"
}