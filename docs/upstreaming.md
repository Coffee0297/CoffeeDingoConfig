# Upstreaming CoffeeDingoConfig features to corygrant/dingoConfig: instructions for an LLM agent

You are porting features from this fork (`Coffee0297/CoffeeDingoConfig`, branch `main`) to the original
configurator (`corygrant/dingoConfig`). The goal is **small, reviewable pull requests that look like the
maintainer wrote them**: one feature per PR, in upstream's architecture and code style. A PR that is quick to
read gets merged; a "port the fork" PR does not.

Most features here need firmware support. The firmware side has its own instructions in CoffeeDingoFW
`docs/upstreaming.md`; the firmware PR goes first, and the dingoConfig PR links it.

## 0. The big difference: upstream is a different app

The fork rewrote the UI. Know what can and can't be carried over:

| Layer | Upstream | This fork | What to do |
|---|---|---|---|
| UI | **Blazor Server + MudBlazor**, interactive server rendering, components inject services directly, 20 Hz timer refresh | Svelte 5 SPA (`web/clientapp`) over REST + SignalR | **Nothing ports.** Re-implement every UI part as Razor components in upstream's style |
| Web | No REST API, by design (see upstream `CLAUDE.md`) | `web/Api/LiveApi.cs`, `McpServer.cs` | Don't add an API layer unless the maintainer agrees first |
| Devices | One `FwDevice` + `FwDeviceDef` / `device-definitions.json` for PDM, PDM-Max and CANBoard | Separate `PdmDevice` / `CanboardDevice` | Put the change into `FwDevice`, gate it per device type through the definition |
| Functions | `domain/Devices/Functions/*.cs` with `DeviceParameter` lists | Same idea, similar files | The closest to portable: adapt the C# into upstream's classes |
| Adapters | `infrastructure/Adapters/*` (USB, SLCAN, PCAN, SocketCAN, Sim) | Same folder plus Kvaser, SLCAN-over-TCP | Mostly portable |
| Project file | One `Devices` list | `PdmDevices` / `CanboardDevices` | Follow upstream's format; new fields must be optional |

**Read upstream's `CLAUDE.md` first** and follow it; it describes the architecture the maintainer wants.

## 1. Ground rules

1. **Only port what the operator asks for.** The community poll decides which features go upstream and in what
   order.
2. **One feature = one branch = one PR.** Bug fixes found on the way get their own PR.
3. **Write it into upstream's code as it is today**, never copy fork files over upstream files. Upstream has
   moved on (React Flow editor, plots, force-sleep / mute-TX inputs, sleep-source disables, param protocol
   rework, "write all missing" handling, PR #57 write reliability). Check that the feature isn't already
   there or half there before starting.
4. **Leave fork-only things out**: Coffee naming, the fork README/CHANGELOG, simulator presets, personal paths,
   anything about one specific vehicle.
5. **Nothing outward-facing without the operator.** Push branches to the fork, but ask before opening each
   upstream PR or issue. Always pass `-R` to `gh`.

## 2. Set up

The fork's git history is not related to upstream, so work in a fresh clone of upstream:

```bash
gh repo clone corygrant/dingoConfig dingoConfig-upstream
cd dingoConfig-upstream
git remote add fork https://github.com/Coffee0297/CoffeeDingoConfig.git
git switch -c up/<feature> origin/development
```

**Target branch:** upstream's `development` and `testing` are where work lands (currently the same commit);
`main` is the release. Open PRs against `development` unless the maintainer prefers `testing` (the last outside
PR, #57, went to `testing`). Ask the operator if unsure, and rebase right before opening.

Build and run exactly as upstream's `CLAUDE.md` says (`dotnet build dingoConfig.sln`,
`dotnet run --project web/web.csproj`).

## 3. Match upstream's style

Read the neighbouring upstream files first and copy what you see:

- **Domain functions** (`domain/Devices/Functions/Condition.cs` is the model):
  file-scoped `namespace domain.Devices.Functions;`, `[JsonPropertyName("camelCase")]` on every stored property,
  `[JsonIgnore]` on runtime values, `[Plotable(displayName: "...")]` on live values, `public const int BaseIndex`,
  `[JsonConstructor]` ctor taking `(int number, string name)`, and an `InitParams()` that returns
  `DeviceParameter` entries with `Name = $"condition[{Number}].field"`, `Index = BaseIndex + (Number - 1)`,
  `SubIndex = subIndex++`, `GetValue` / `SetValue` / `ValueType` / `DefaultValue`. The sub-index order **must match
  the firmware's** param table.
- **UI:** a function's editor is a MudBlazor grid in `web/Components/Devices/FwDevice/Functions/<Name>Grid.razor`
  deriving from `FunctionComponentBase`, placed on `Tabs/ConfigurationTab.razor`; live values on
  `Tabs/DashboardTab.razor`; graph support in `Flow/FlowNodeTypes.cs` + `FlowGraph.cs`. Copy an existing grid.
- **Layout:** keep the file's brace style and spacing (upstream writes `{get; set; }` compactly in places). Don't
  reformat lines you didn't change.
- **Comments:** few, only for the non-obvious.
- **Dependencies:** no new NuGet packages unless the feature needs one (Kvaser needs none: P/Invoke), and say so.
- **Commit messages:** upstream style is a short lowercase imperative subject, no prefix:
  `add timer function`, `fix can input offset and factor binding`. Ask the operator whether to add an AI
  co-author line.
- **Don't bump `<Version>`** in `web.csproj`; the maintainer does "bump version" commits himself.

## 4. Compatibility rules

- **Project files:** new properties need defaults so older project files still load, and older dingoConfig
  versions should ignore them safely.
- **Firmware dependency:** hide or disable the feature on firmware that doesn't have it, the way upstream
  already gates features (`FwDeviceDef` capability flags / minimum version in `device-definitions.json`). Never
  write params a module doesn't have.
- **Params must match the firmware PR exactly**: indices, sub-indices, types, var-map positions. Take them from
  the upstream firmware PR, not from the fork (the indices may have been renumbered there).

## 5. Each PR: checklist

1. Branch fresh from `origin/development`.
2. Domain/param change first, then the UI, in upstream style.
3. `dotnet build dingoConfig.sln` with no new warnings; run the app and use the feature against a module or
   CoffeeDingoSim (SLCAN on a virtual COM pair, see the Sim README). Write down what you tested.
4. Open an old project file and save it again: nothing lost.
5. Keep the diff small: aim for under ~400 changed lines. If it's bigger, split it (e.g. domain + params first,
   then the grid, then the flow-editor node).
6. Read your own diff: no unrelated reformatting, no fork-only references.
7. Push to the fork, draft the PR text, then **ask the operator** before opening it:
   ```bash
   git push fork up/<feature>
   gh pr create -R corygrant/dingoConfig --base development --head Coffee0297:up/<feature> --title "..." --body-file pr.md
   ```

**PR description template**

```markdown
## What
One paragraph: what the user can now do.

## Why
The use case (link the Discord poll / issue).

## Changes
- Domain / params: new properties, param indices and sub-indices
- UI: where it shows up
- Project file: new fields (all optional)

## Firmware
Needs dingoFW PR #... (or "none"); how the UI behaves on older firmware.

## Testing
What was tested, against hardware or the simulator.
```

## 6. Suggested order and how to split

| # | Feature (where it lives in the fork) | Split into | Notes |
|---|---|---|---|
| 1 | Kvaser adapter (`infrastructure/Adapters/KvaserAdapter.cs`) | 1 PR | Self-contained, no firmware needed: a good first PR |
| 2 | SLCAN over TCP (`tcp://host:port` in `SlcanAdapter.cs`) | 1 PR | Lets dingoConfig talk to the simulator |
| 3 | Receive accept-filter during read/write/flash (`ICommsAdapter.SetReceiveFilter`, `DeviceManager`) | 1 PR | Fixes config on a busy bus; check against #57 |
| 4 | Confirmed single writes and Write All fallback (`ParamProtocol.cs`, `DeviceManager`) | 1–2 PRs | Upstream reworked the param protocol: port only what's still missing. Needs the firmware "refused write reply" PR |
| 5 | Bus discovery / Add from CAN (`/discover`, `/identify` logic in `DeviceManager`) | 1 PR | Handles the PDM's base − 2 offset |
| 6 | Flash firmware over USB DFU from the app (`FirmwareFlashService.cs`) | 1 PR | Upstream only has "enter bootloader"; dfu-util has to be found or shipped per platform |
| 7 | Flash a blank board over DFU | 1 PR | On top of 6 |
| 8 | Flash over CAN (`CanFlashService.cs`, `XcpCanMaster.cs`, `SRecordImage.cs`) | 1–2 PRs | Only after the firmware bootloader is accepted |
| 9 | Condition hysteresis, timers, lookup tables, PWM frequency from a signal, CANBoard DO PWM | 1 PR each | One per firmware PR; each a domain class + grid + flow node |
| 10 | Analog calibrated rotary + ladder designer, linear sensor scaling | 2–3 PRs | Designer UI separate from the decode params |
| 11 | PWM input editor (`DigitalInput.cs` sub 5–7) | 1 PR | Per-board frequency limits from `FwDeviceDef` |
| 12 | Warning / open-load, trip log viewer, output bench test | 1 PR each | Each needs its firmware PR |
| 13 | CAN-ID conflict guard + Suggest free base ID (`canids.js` logic) | 1 PR | Re-implement the JS logic in C# |
| 14 | Cross-module signals (CAN input from another module's broadcast) | 1 PR | |
| 15 | System view with car map, cross-module functions, sleep sequence designer, Circuit Builder wizards, Lua editor | Discuss first | Large UI features; propose the design in Blazor before coding. Lua needs the firmware Lua PR |
| 16 | REST API, MCP server, tests project + CI | Discuss first | Goes against upstream's "no REST API" design; only with the maintainer's agreement |

**"Discuss first"** means: open an upstream issue (or have the operator raise it on Discord) with the plan and
the split, and wait for the maintainer's OK before writing the code.

## 7. When to stop and ask the operator

- The feature needs a design decision because upstream's architecture differs.
- Param indices or project-file fields could clash with upstream's plans.
- The firmware PR it depends on isn't merged or was changed in review.
- The diff won't go under ~400 lines and there's no clean split.
- Before opening any PR or issue on `corygrant/*`.
