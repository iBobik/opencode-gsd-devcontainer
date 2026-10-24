import { Plugin } from "@opencode/plugin/tui"
import { Show } from "solid-js"
import { CouncilUI, type CouncilDisplay } from "./council-rpc"
import { councilDisplay } from "./display"

export default Plugin.define({
  id: "council-ui",
  setup(ctx) {
    const council = ctx.client.rpc(CouncilUI)
    return ctx.ui.slot({
      append: "session.composer.top",
      render: (props) => {
        const display = councilDisplay(() => props.sessionID, async (sessionID) => {
          const location = ctx.data.session.get(sessionID)?.location ?? ctx.location ?? ctx.data.location.default()
          return await council.status({ sessionID }, { location, signal: AbortSignal.timeout(5000) }) as CouncilDisplay
        })
        return <Show when={display()?.running || (display()?.text && !display()?.deliveryConfirmed)}>
          <text fg={ctx.theme.text.base}>Council status — {display()?.status}</text>
          <Show when={!display()?.running}>
            <text fg={ctx.theme.text.base}>Report delivery unconfirmed. Run /council-last to show saved output.</text>
          </Show>
        </Show>
      },
    })
  },
})
