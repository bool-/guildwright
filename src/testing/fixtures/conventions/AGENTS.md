# AGENTS.md (fixture)

A tiny stand-in for a module repo's contributor guide. It carries exactly the needles the
convention suite looks for, and nothing else.

1. Generate a module with the scaffold.
2. Definition of done: `npm run check` passes and your pull request body carries an
   `## Operator action required` section.

## Operator action required

Give an entry for each of these your change introduces:

1. A privileged gateway intent: MESSAGE_CONTENT, GUILD_MEMBERS or GUILD_PRESENCES, toggled under
   Privileged Gateway Intents. MESSAGE_CONTENT needs DISCORD_MESSAGE_CONTENT=true; without it the
   bot refuses to start.
2. A name added to a `needs: [...]` array changes the permissions integer, so re-invite the bot.
3. A new required key in EnvSchema.
4. A new dependency: write CORE-CHANGE-NEEDED.
5. Anything touching requireOwnCredentials or resolveBuildPayer; requesters use /credentials set.

When nothing applies, the section reads `None.`
