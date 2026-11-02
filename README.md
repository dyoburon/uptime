# uptime

Checks afk.ai, its API and the Modal cloud rigger every 5 minutes (GitHub Actions) and sends alerts to a phone through
[ntfy](https://ntfy.sh).

- Down (an error, or no answer in 20 s, twice 30 s apart): an urgent push, a reminder every hour, and a push when it's back.
- The Modal rigger answering but not rigging (switched off, or the month's free budget spent): one normal push.
- Once a week: a quiet "monitor is running" push, so a silent phone means all's well and not a dead monitor.

Setup: the ntfy app subscribed to the topic in the `NTFY_TOPIC` secret. Test: Actions > Uptime > Run workflow, tick "test".
Checks are in `check.mjs`; `state.json` is what it last saw.
