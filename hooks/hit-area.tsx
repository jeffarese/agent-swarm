import type { ClientModule } from 'claude-code'

/** An empty region laid over a card: draws nothing, so the card shows through, and posts a click. */
const HitArea: ClientModule<{ id: string }> = (props, surface) => {
  surface.onPointer(e => {
    if (e.type === 'down' && e.button === 'left') surface.post({ pick: props.id })
  })
  const { Box } = surface.elements

  return <Box width={surface.columns} height={surface.rows} />
}

export default HitArea
