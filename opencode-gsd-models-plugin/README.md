# GSD Model Profiles

This OpenCode plugin routes only `gsd-*` subagents. It reads the GSD-installed
model catalog, so new GSD agents use their declared heavy, standard, or light
routing tier without duplicating the catalog in this repository.

Set one of `claude`, `gpt`, or `mixed` before starting OpenCode:

```sh
GSD_MODELS_PROFILE=gpt opencode
```

The plugin resolves values in this order: process environment, repository
`.env`, `.devcontainer/.env`, authenticated Anthropic/OpenAI/PPQ provider, then session-model
inheritance. It reads only `GSD_MODELS_PROFILE` from `.env`; it never writes,
sources, or otherwise imports that file. Restart OpenCode after changing it.

`/gsd-models-profile` reports the active selection and manual commands.
It does not change configuration or `.env`.

GSD itself remains neutral with `model_profile: "inherit"` and
`resolve_model_ids: "omit"`. The plugin guards common GSD config setters and
reports configuration drift, but direct external process changes cannot be
completely intercepted by an OpenCode plugin.
