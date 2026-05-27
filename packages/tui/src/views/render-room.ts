import React from 'react'
import type { RoomView as RoomViewType } from '@openslack/collaboration'
import { renderTui } from '../render.js'
import { mapRoomToViewModel } from '../view-models/room.js'
import RoomView from './RoomView.js'

export async function renderRoomTui(view: RoomViewType): Promise<void> {
  const model = mapRoomToViewModel(view)
  const { unmount } = await renderTui(
    React.createElement(RoomView, { model }),
  )
}
