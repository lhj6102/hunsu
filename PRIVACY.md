# Privacy

Hunsu reads data only from GitHub repositories granted to the installed GitHub App and from product commands submitted by authenticated users or OAuth clients.

Repository source, Project state, Goal content, Runner definitions, Run evidence, and commit metadata remain in the selected GitHub repository unless an operator separately enables application telemetry. The Web projection cache is derived, disposable, and reconstructable from GitHub.

Hunsu stores a signed browser session containing the minimum authorization context needed to select an installation and user. Installation tokens and OAuth values are short-lived credentials and are not committed to repositories or bundled with the plugin.

Webhook delivery identifiers may be retained long enough to prevent duplicate processing. Logs should contain request correlation identifiers and safe error codes, never raw authorization headers, cookies, private keys, tokens, webhook bodies, or repository file contents.

Removing the GitHub App installation revokes future repository access. Deleting an application projection does not delete repository state; deleting durable state requires an intentional GitHub operation governed by the repository owner.
