import { Rpc } from "@opencode/plugin/rpc"

export type CouncilDisplay = {
  status: string
  text: string
  running: boolean
  runID?: string
  memberCount?: number
  invocationID?: string
  updatedAt?: number
  createdAt?: number
  deliveryConfirmed?: boolean
  hasSynthesis?: boolean
}

export const CouncilUI = Rpc.define({
  id: "council-ui",
  events: {},
  methods: {
    status: {
      input: { type: "object", properties: { sessionID: { type: "string" } }, required: ["sessionID"], additionalProperties: false },
      output: {
        type: "object",
        properties: { status: { type: "string" }, text: { type: "string" }, running: { type: "boolean" }, runID: { type: "string" }, memberCount: { type: "integer" }, invocationID: { type: "string" }, updatedAt: { type: "number" }, createdAt: { type: "number" }, deliveryConfirmed: { type: "boolean" }, hasSynthesis: { type: "boolean" } },
        required: ["status", "text", "running"], additionalProperties: false,
      },
    },
  },
})
