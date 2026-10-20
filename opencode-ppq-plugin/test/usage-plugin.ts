/** Test-only transport redirect. Production provider defaults remain untouched. */
import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "ppq-usage-test",
  async setup(ctx) {
    await ctx.session.hook("title", (event) => { event.result = "PPQ usage test" })
    await ctx.session.hook("http.request", (event) => {
      if (event.model.providerID !== "ppq") throw new Error("Unexpected provider in isolated PPQ usage test")
      const url = new URL(event.request.url)
      if (url.origin !== "https://api.ppq.ai" || url.pathname !== "/chat/completions") {
        throw new Error(`Unexpected PPQ endpoint: ${url.origin}${url.pathname}`)
      }
      event.request = new Request("http://127.0.0.1:18743/chat/completions", event.request)
    })
  },
})
