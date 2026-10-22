// @kurumi/slack/contract
import { kc } from '@kurumi/rpc/contract'
import { z } from 'zod'

export const contract = {
  instances: {
    list: kc.meta({ cli: true }),
    add: kc.meta({ cli: true }).input(z.object({ name: z.string(), botToken: z.string(), appToken: z.string().optional() })),
  },
  rooms: {
    create: kc
      .meta({ cli: true, agent: 'scoped', humanHold: 'rooms.create', tool: { name: 'create_room', instructions: 'Create a Slack room with other agents and the operator.' } })
      .input(z.object({ name: z.string(), agentGroupIds: z.array(z.string()) })),
    addAgent: kc
      .meta({ cli: true, agent: 'scoped', humanHold: 'rooms.add_agent', tool: { name: 'add_to_room', instructions: 'Add an agent to a room.' } })
      .input(z.object({ channelId: z.string(), agentGroupId: z.string() })),
  },
  canvas: {
    read: kc.meta({ agent: 'own-group', tool: { name: 'canvas_read', instructions: 'Read the room canvas.' } }).input(z.object({ channelId: z.string() })),
    update: kc.meta({ agent: 'own-group', tool: { name: 'canvas_update', instructions: 'Update the room canvas.' } }).input(z.object({ channelId: z.string(), markdown: z.string() })),
  },
}
