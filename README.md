# opencode-surplus

An [OpenCode](https://opencode.ai) plugin for people who buy tokens through [Surplus Intelligence](https://www.surplusintelligence.ai).

It lists every Surplus model in OpenCode's model picker, lets you set a minimum discount per model, and shows what you're actually paying while you work.

This version is for OpenCode 2.2 and newer. If you're still on OpenCode 1.x, use the [`v1.1.0`](../../tree/v1.1.0) tag instead, because 1.x plugins don't run on 2.x.

## What you get

While a session is running, the prompt footer shows a small speed meter: tokens per second right now, the average for the session, and how long the first token took.

The sidebar shows how much you've spent today, how much that saved you versus list price, and your average price per million tokens. Below that you'll see the discount floor for the current model, the three cheapest sellers for it right now, and which seller (if any) you've pinned it to.

There are a handful of `/surplus-...` commands for checking prices and changing settings. They answer instantly and don't call a model, so they cost nothing. The same things are available to the agent as tools, so you can also just ask it to "set a 90% floor on kimi".

## Install

```bash
git clone https://github.com/<your-user>/opencode-surplus.git
cd opencode-surplus
./install.sh
```

This copies the `surplus/` folder to `~/.config/opencode/plugins/surplus/`. OpenCode finds plugins in that folder on its own, so you don't need to register it anywhere. If you had the old 1.x version installed, the script moves those files into a backup folder.

Then add the provider to `~/.config/opencode/opencode.jsonc`, if it isn't there already:

```jsonc
{
  "providers": {
    "surplus-intelligence": {
      "name": "Surplus Intelligence",
      "package": "@opencode/ai/providers/openai-compatible",
      "settings": { "baseURL": "https://api.surplusintelligence.ai/v1" }
    }
  }
}
```

You don't need to list any models; the plugin fills them in. Finally, run `/connect` in OpenCode, choose `surplus-intelligence`, and paste your API key. The plugin reads the key from OpenCode when it needs it and never stores it anywhere itself.

## Commands

Type `/` and start typing `surplus`, or open the command palette with Ctrl+P and look under "Surplus".

| Command | What it does |
|---|---|
| `/surplus` or `/surplus-status` | Current model, floor, pin, best offer and session cost |
| `/surplus-offers` | The ten best sellers for the current model right now |
| `/surplus-tier` | Set the minimum discount for the current model: 70, 80, 90, 95% or off |
| `/surplus-pin` | Send the current model to one particular seller, or remove the pin |
| `/surplus-clear` | Forget the floor and pin for the current model |
| `/surplus-spend` | Today's spend and savings, plus this session |
| `/surplus-models` | List the Surplus models the plugin found |
| `/surplus-flag` | Turn the "floor not met" pop-up on or off (see below) |
| `/surplus-tui` | Hide or show the meter and sidebar until you restart |

The agent tools are `surplus_offers`, `surplus_pin`, `surplus_tier`, `surplus_settier`, `surplus_flag`, `surplus_models`, `surplus_backoff`, `surplus_spend` and `surplus_clear`.

## Discount floors

A floor tells Surplus "only send this to sellers who are at least N% below list price". If nobody is that cheap at the moment, the request fails with `minimum_discount_not_met` instead of quietly costing more.

Changing a floor takes effect on your next message. You don't need to restart anything.

If you'd rather not deal with those failures yourself, turn on `/surplus-flag`. When a request fails because of the floor, you'll get a pop-up suggesting the strictest floor that would work right now. Pick it and your last message is sent again.

## Pins

Pinning keeps a model on one seller. That's useful because sellers cache your prompt, and hopping between them throws that cache away. Out of the box the GLM models are pinned to Z.ai's coding endpoint, because that's what the author uses. Change `BASE_PINS` in `surplus/index.js` if you want something different, then run `./install.sh` again.

## Where the numbers come from

Today's figures come straight from Surplus's own usage records, so they match your bill.

The offer prices in the sidebar aren't the sticker price. They're adjusted to how you actually use the model, meaning your mix of input and output tokens and how often your prompts hit the cache, so they're closer to what you'd really pay.

For the session cost, the plugin compares your recent requests with what Surplus actually charged and works out the real per-token price for each model. It needs about five requests on a model before it trusts the result. After that, OpenCode's own "spent" figures use those prices too. Until then it uses the cheapest live offer.

## Options

Most people won't need these. To change them, add the plugin to `opencode.jsonc` with options:

```jsonc
{
  "plugins": [{
    "package": "./plugins/surplus",
    "options": {
      "providerID": "surplus-intelligence",
      "enabled": true,
      "offers": { "filterByPin": false },
      "spinner": { "theme": "tech" },
      "tiers": {
        "tps":  { "slow": 20, "normal": 50, "fast": 100 },
        "ttft": { "fast": 10000, "ok": 20000 }
      }
    }
  }]
}
```

`providerID` is the provider the plugin looks after, if you named yours differently. `enabled: false` turns off the meter, sidebar and commands but keeps the models. `filterByPin` only shows offers from the seller you pinned. `spinner` can be `tech`, `red` or `none`. `tiers` sets when the speed meter turns red, yellow or green.

## Updating the model list

The plugin refreshes the model list in the background every few hours and prices every 15 minutes. If you want to refresh it by hand, or before OpenCode has run once:

```bash
node sync-models.mjs
```

Add `--query gpt` to search the list. If you also set `SURPLUS_API_KEY`, it shows current discounts too.

## When something's wrong

If there are no Surplus models in `/models`, check that the provider block above is in your config. Then run `opencode api get /api/plugin` and make sure `surplus` shows as active.

If the sidebar is empty, you're probably on a non-Surplus model, or you haven't connected your key with `/connect`.

If you keep getting `minimum_discount_not_met`, your floor is stricter than anything on offer right now. Lower it with `/surplus-tier`.

For anything else, look in `~/.local/share/opencode/log/opencode.log` and search for `surplus`.

## License

MIT, see `LICENSE`.
