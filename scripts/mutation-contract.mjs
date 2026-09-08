import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const repository = fileURLToPath(new URL("..", import.meta.url))
const root = await mkdtemp(join(tmpdir(), "opencode-goal-pro-max-complete-plugin-mutations-"))

function matchCheckoutNewlines(value, source) {
  const newline = source.includes("\r\n") ? "\r\n" : "\n"
  return value.replace(/\r?\n/g, newline)
}

// An anchor may be a literal string or a RegExp, and `to` may be a replacement
// string or a function receiving the match.
//
// Prefer a RegExp whenever the anchored line carries a value that legitimately
// grows — a set's members, a list of names, an enumeration. A literal anchor
// pins that value, so the next honest edit to it silently detaches the mutant
// and the contract fails as if a safety property had broken. Anchor on the
// declaration and mutate relative to the match instead.
//
// Literal anchors remain right for pinned *logic* — a comparison, a call, an
// assignment — where a change to the line genuinely should force someone to
// re-examine whether the mutant still expresses the property under test.
//
// RegExp anchors are matched against the file as checked out, so keep them to a
// single line; a literal anchor spanning lines is normalised for CRLF, a RegExp
// is not.
function locateMutation(mutant, original) {
  if (mutant.from instanceof RegExp) {
    const flags = mutant.from.flags.includes("g")
      ? mutant.from.flags
      : `${mutant.from.flags}g`
    const pattern = new RegExp(mutant.from.source, flags)
    return {
      occurrences: [...original.matchAll(pattern)].length,
      mutate: () => original.replace(pattern, mutant.to),
    }
  }
  const from = matchCheckoutNewlines(mutant.from, original)
  const to =
    typeof mutant.to === "function" ? mutant.to : matchCheckoutNewlines(mutant.to, original)
  return {
    occurrences: original.split(from).length - 1,
    mutate: () => original.replace(from, to),
  }
}

function staleAnchorMessage(mutant, occurrences) {
  if (occurrences === 0) {
    return (
      `${mutant.name}: mutation anchor no longer matches anything in ${mutant.file}.\n` +
      `This is a stale anchor, not a failed safety property: the source moved on and the\n` +
      `mutant no longer points at it. Update this mutant in scripts/mutation-contract.mjs to\n` +
      `match the current source. Note the property it guards is UNVERIFIED until you do.\n` +
      `If the anchored value is one that legitimately changes over time, re-anchor it on the\n` +
      `surrounding declaration with a RegExp so the next edit does not detach it again.`
    )
  }
  return (
    `${mutant.name}: mutation anchor matches ${mutant.file} ${occurrences} times and must\n` +
    `match exactly once. Tighten the anchor in scripts/mutation-contract.mjs so it selects a\n` +
    `single site — mutating several at once does not prove which one the test caught.`
  )
}

const mutants = [
  {
    name: "verifier default deny",
    file: "src/native-agent-config.js",
    from: '\"*\": \"deny\"',
    to: '\"*\": \"allow\"',
    test: "test/native-agent-config.test.js",
  },
  {
    name: "mutating SDK calls are never replayed",
    file: "src/opencode-session-api.js",
    // Anchored on the declaration, not its members: the replay-safe set grows
    // whenever a read-only operation is added, and a literal anchor detaches
    // every time it does. Adding a mutating operation must stay caught.
    from: /const REPLAY_SAFE_OPERATIONS = new Set\(\[[^\]]*\]\)/,
    to: (match) => match.replace(/\]\)$/, ', "prompt"])'),
    test: "test/opencode-session-api.test.js",
  },
  {
    name: "planning-only agents hold new goals unless explicitly opted out",
    file: "src/goal-plugin.js",
    from: "const allowGoalExecutionFromPlan = pluginOptions.allowGoalExecutionFromPlan === true",
    to: "const allowGoalExecutionFromPlan = true",
    test: "test/goal-plugin.test.js",
  },
  {
    name: "completion evidence must be adjacent",
    file: "src/goal-plugin.js",
    from: "const previous = markerIndex - 1",
    to: "const previous = markerIndex - 2",
    test: "test/goal-plugin.test.js",
  },
  {
    name: "terminal completion requires durable storage",
    file: "src/goal-plugin.js",
    from: 'const durable = await persistFinal(sessionID, "completion", ledgerDurable)\n        if (durable === false) {',
    to: 'const durable = await persistFinal(sessionID, "completion", ledgerDurable)\n        if (false) {',
    test: "test/goal-plugin.test.js",
  },
  {
    name: "terminal rollback detects same-session mutation without cross-session coupling",
    file: "src/goal-plugin.js",
    from: "if ((sessionMutationVersions.get(sessionID) || 0) !== snapshot?.mutationVersion) return false",
    to: "if (false) return false",
    test: "test/goal-plugin.test.js",
  },
  {
    name: "token accounting resets only after compaction succeeds",
    file: "src/goal-plugin.js",
    from: 'event?.type === \"session.compacted\"',
    to: 'event?.type === \"session.compacting\"',
    test: "test/goal-plugin.test.js",
  },
  {
    name: "command output mutates the host-retained parts array",
    file: "src/goal-plugin.js",
    from: "currentParts.splice(0, currentParts.length, ...nextParts)",
    to: "output.parts = nextParts",
    test: "test/goal-plugin.test.js",
  },
  {
    name: "command results carry plugin provenance",
    file: "src/goal-plugin.js",
    from: '"opencode-goal-plugin": { kind: "command", id: commandID },',
    to: '"opencode-goal-plugin": { kind: "human", id: commandID },',
    test: "test/goal-plugin.test.js",
  },
  {
    name: "command provenance requires a pending runtime correlation",
    file: "src/goal-plugin.js",
    from: "const commandTurn = consumePendingCommandTurn(sessionID, message)",
    to: 'const commandTurn = pluginMessageCorrelationID(message, "command") ? { id: pluginMessageCorrelationID(message, "command"), policy: "work" } : null',
    test: "test/goal-plugin.test.js",
  },
  {
    name: "handled command errors default to a control boundary",
    file: "src/goal-plugin.js",
    from: 'commandTurn.policy = startsWork ? "work" : "control"',
    to: 'commandTurn.policy = "work"',
    test: "test/goal-plugin.test.js",
  },
  {
    name: "control command results carry direct reporting instructions",
    file: "src/goal-plugin.js",
    from: "const routedText = startsWork ? String(text) : frameControlCommandText(text)",
    to: "const routedText = String(text)",
    test: "test/goal-plugin.test.js",
  },
  {
    name: "control command data cannot break its reporting frame",
    file: "src/goal-plugin.js",
    from: "    escapeGoalText(text),\n    \"</goal_command_result>\",",
    to: "    String(text),\n    \"</goal_command_result>\",",
    test: "test/goal-plugin.test.js",
  },
  {
    name: "resolved attachment companions require a retained input file",
    file: "src/goal-plugin.js",
    from: "turn?.preservedFileCount > 0",
    to: "true",
    test: "test/goal-plugin.test.js",
  },
  {
    name: "retained attachments accept OpenCode's resolved companions",
    file: "src/goal-plugin.js",
    from: "turn?.preservedFileCount > 0",
    to: "false",
    test: "test/goal-plugin.test.js",
  },
  {
    name: "each retained attachment yields at least one resolved companion",
    file: "src/goal-plugin.js",
    from: "companionParts.length >= turn.preservedFileCount",
    to: "companionParts.length >= 0",
    test: "test/goal-plugin.test.js",
  },
  {
    name: "attachment failures become read-only control turns",
    file: "src/goal-plugin.js",
    from: 'resolvingCommandTurn.policy = "control"',
    to: 'resolvingCommandTurn.policy = "work"',
    test: "test/goal-plugin.test.js",
  },
  {
    name: "attachment failures refresh expired command correlations",
    file: "src/goal-plugin.js",
    from: "resolvingCommandTurn.createdAt = Date.now()",
    to: "resolvingCommandTurn.createdAt = resolvingCommandTurn.createdAt",
    test: "test/goal-plugin.test.js",
  },
  {
    name: "control turns block every tool call",
    file: "src/goal-plugin.js",
    // Re-anchored at v1.0.1 wave-2 integration. T10 inverted this guard (the early
    // return became a positive block) so the todo mirror below it can run on ordinary
    // turns; the throw and its text are unchanged. The mutant is the same property in
    // the new shape: let a control turn stop blocking one tool.
    from: 'if (currentRuntime().activeCommandTurns.get(sessionID)?.policy === "control") {',
    to: 'if (currentRuntime().activeCommandTurns.get(sessionID)?.policy === "control" && input?.tool !== "read") {',
    test: "test/goal-plugin.test.js",
  },
  {
    name: "resolved command parts remain bound to one host message",
    file: "src/goal-plugin.js",
    from: "const partsBelongToResolvedMessage =\n    Boolean(resolvedMessageID) &&\n    resolvedSessionID === sessionID &&\n    messageParts.every(\n      (candidate) =>\n        candidate?.messageID === resolvedMessageID && candidate?.sessionID === sessionID,\n    )",
    to: "const partsBelongToResolvedMessage = true",
    test: "test/goal-plugin.test.js",
  },
  {
    name: "resolved attachment companions cannot carry plugin metadata",
    file: "src/goal-plugin.js",
    from: '!part?.metadata?.["opencode-goal-plugin"] &&',
    to: "true &&",
    test: "test/goal-plugin.test.js",
  },
  {
    name: "control responses are excluded from terminal analysis",
    file: "src/goal-plugin.js",
    from: "currentRuntime().suppressedCommandAssistants.get(latestAssistantID) === sessionID ||",
    to: "false ||",
    test: "test/goal-plugin.test.js",
  },
  {
    name: "control responses do not advance progress timestamps",
    file: "src/goal-plugin.js",
    from: '    parentOwner?.policy === "control" &&\n',
    to: "    false &&\n",
    test: "test/goal-plugin.test.js",
  },
  {
    name: "command boundaries match their assistant parent",
    file: "src/goal-plugin.js",
    from: "messageParentID(commandAssistant) !== activeCommandTurn.messageID",
    to: "false",
    test: "test/goal-plugin.test.js",
  },
  {
    name: "only typed lease contention enters passive mode",
    file: "src/persistence-lease.js",
    from: "return error instanceof PersistenceLeaseContendedError",
    to: "return true",
    test: "test/persistence-lease.test.js",
  },
  {
    name: "stored owner hostnames are validated separately from diagnostics",
    file: "src/persistence-lease.js",
    from: "    validStoredHostname(owner.hostname)",
    to: "    validDisplayHostname(owner.hostname)",
    test: "test/persistence-lease.test.js",
  },
  {
    name: "bounded owner records tolerate legal short reads",
    file: "src/persistence-lease.js",
    from: "  while (bytesReadTotal < buffer.length) {",
    to: "  if (bytesReadTotal < buffer.length) {",
    test: "test/persistence-lease.test.js",
  },
  {
    name: "overlapping immutable lease claimants cannot both win",
    file: "src/persistence-lease.js",
    from: "      if (!observed.ownFound || observed.blocked) {",
    to: "      if (false) {",
    test: "test/persistence-lease.test.js",
  },
  {
    name: "compatibility guard publication is atomic and no-replace",
    file: "src/persistence-lease.js",
    from: "      await linkGuard(temporaryPath, lockPath)",
    to: "      await fs.rename(temporaryPath, lockPath)",
    test: "test/persistence-lease.test.js",
  },
  {
    name: "compatibility guards are complete before publication",
    file: "src/persistence-lease.js",
    from: "    await handle.utimes(guardDate, guardDate)",
    to: "    await Promise.resolve()",
    test: "test/persistence-lease.test.js",
  },
  {
    name: "compatibility guards require the exact sentinel schema",
    file: "src/persistence-lease.js",
    from: '    Object.keys(owner).sort().join(",") ===\n      "createdAt,hostname,pid,protocol,sentinel,token" &&',
    to: "    true &&",
    test: "test/persistence-lease.test.js",
  },
  {
    name: "vanished version-1 guards retry after publication contention",
    file: "src/persistence-lease.js",
    from: '      if (error?.code === "EEXIST") return null',
    to: "      if (false) return null",
    test: "test/persistence-lease.test.js",
  },
  {
    name: "ownership is returned only while the compatibility guard exists",
    file: "src/persistence-lease.js",
    from: "      await ensureLegacyGuard(lockPath, { beforeGuardLink, afterGuardLink, linkGuard })\n      return createLease(",
    to: "      await Promise.resolve()\n      return createLease(",
    test: "test/persistence-lease.test.js",
  },
  {
    name: "unsupported hard-link filesystems fail closed",
    file: "src/persistence-lease.js",
    from: "      if (hardLinkUnsupported(error)) throw persistenceLeaseHardLinkError()",
    to: "      if (false) throw persistenceLeaseHardLinkError()",
    test: "test/persistence-lease.test.js",
  },
  {
    name: "unknown future claim filenames block conservatively",
    file: "src/persistence-lease.js",
    from: "      if (isClaimLikeName(entry.name)) {",
    to: "      if (false) {",
    test: "test/persistence-lease.test.js",
  },
  {
    name: "future lease protocols block conservatively",
    file: "src/persistence-lease.js",
    from: "    if (record.owner.protocol !== LEASE_PROTOCOL_VERSION) {",
    to: "    if (false) {",
    test: "test/persistence-lease.test.js",
  },
  {
    name: "lease release teardown is single-entry",
    file: "src/persistence-lease.js",
    from: "      if (released || releasing) return false",
    to: "      if (released) return false",
    test: "test/persistence-lease.test.js",
  },
  {
    name: "disposed instances do not perform delayed legacy migration",
    file: "src/goal-plugin.js",
    from: "    try {\n      if (currentRuntime().disposed) return\n      if (await pathExists(persistenceOptions.migrationMarkerPath)) return",
    to: "    try {\n      if (false) return\n      if (await pathExists(persistenceOptions.migrationMarkerPath)) return",
    test: "test/goal-plugin.test.js",
  },
  {
    name: "fresh migration markers require aggregate lease ownership",
    file: "src/goal-plugin.js",
    from: "  const freshMigrationLease = await acquireMigrationLease(\n    persistenceOptions.stateFilePath,\n    persistenceOptions.migrationMarkerPath,\n  )",
    to: "  const freshMigrationLease = { release: async () => false }",
    test: "test/session-concurrency.test.js",
  },
  {
    name: "fresh migration marker leases are released",
    file: "src/goal-plugin.js",
    from: "    await freshMigrationLease.release()",
    to: "    await Promise.resolve()",
    test: "test/session-concurrency.test.js",
  },
  {
    name: "disposed command continuations cannot mutate state",
    file: "src/goal-plugin.js",
    from: "      const loadResult = await ensureSessionLoaded(sessionID, {\n        retryPassive: true,\n        freshCommandBoundary: true,\n      })\n      if (currentRuntime().disposed || loadResult.kind === \"disposed\") return\n      const commandTurn = registerPendingCommandTurn(sessionID, output)",
    to: "      const loadResult = await ensureSessionLoaded(sessionID, {\n        retryPassive: true,\n        freshCommandBoundary: true,\n      })\n      if (loadResult.kind === \"disposed\") return\n      const commandTurn = registerPendingCommandTurn(sessionID, output)",
    test: "test/host-lifecycle.test.js",
  },
  {
    name: "disposed tool continuations cannot invoke handlers",
    file: "src/goal-plugin.js",
    from: '  if (disposed || loadResult?.kind === "disposed") {',
    to: '  if (loadResult?.kind === "disposed") {',
    test: "test/host-lifecycle.test.js",
  },
  {
    name: "session storage failures remain fatal",
    file: "src/goal-plugin.js",
    from: "      } catch (error) {\n        if (!isPersistenceLeaseContendedError(error)) throw error\n        return enterPassiveSession(sessionID, error)\n      }",
    to: "      } catch (error) {\n        if (false) throw error\n        return enterPassiveSession(sessionID, error)\n      }",
    test: "test/goal-plugin.test.js",
  },
  {
    name: "overlapping hooks await one complete session load",
    file: "src/goal-plugin.js",
    from: "    const existingLoad = runtime.sessionLoadPromises.get(sessionID)\n    if (existingLoad) return existingLoad\n    if (runtime.sessionPersistence.has(sessionID)) return ACTIVE_PERSISTENCE_OWNED",
    to: "    if (runtime.sessionPersistence.has(sessionID)) return ACTIVE_PERSISTENCE_OWNED\n    const existingLoad = runtime.sessionLoadPromises.get(sessionID)\n    if (existingLoad) return existingLoad",
    test: "test/goal-plugin.test.js",
  },
  {
    name: "passive load results cannot masquerade as active",
    file: "src/goal-plugin.js",
    from: "  const passiveLoadResult = (entry) => ({\n    kind: \"passive\",\n    code: SESSION_OWNED_ELSEWHERE,",
    to: "  const passiveLoadResult = (entry) => ({\n    kind: \"active\",\n    code: SESSION_OWNED_ELSEWHERE,",
    test: "test/host-lifecycle.test.js",
  },
  {
    name: "legacy lease recovery reason reaches passive controls",
    file: "src/goal-plugin.js",
    from: "    reason: entry.reason,",
    to: '    reason: "owned_elsewhere",',
    test: "test/host-lifecycle.test.js",
  },
  {
    name: "host logging never retains a persistence lease",
    file: "src/goal-plugin.js",
    from: "    void Promise.resolve(call()).catch(onFailure)",
    to: "    return Promise.resolve(call()).catch(onFailure)",
    test: "test/host-lifecycle.test.js",
  },
  {
    name: "disposed idle lookups cannot repopulate command state",
    file: "src/goal-plugin.js",
    from: "    if (runtime.disposed) return { ready: false, messages: null }\n    const commandMessages = Array.isArray(commandHostMessages)\n      ? commandHostMessages.slice(-messageLimit)\n      : []\n    if (runtime.activeCommandTurns.get(sessionID) !== activeCommandTurn) {",
    to: "    if (false) return { ready: false, messages: null }\n    const commandMessages = Array.isArray(commandHostMessages)\n      ? commandHostMessages.slice(-messageLimit)\n      : []\n    if (false) {",
    test: "test/host-lifecycle.test.js",
  },
  {
    name: "a delayed idle lookup cannot retire a newer command guard",
    file: "src/goal-plugin.js",
    from: "    if (runtime.activeCommandTurns.get(sessionID) !== activeCommandTurn) {",
    to: "    if (false) {",
    test: "test/host-lifecycle.test.js",
  },
  {
    name: "passive command guards survive stale idle events",
    file: "src/goal-plugin.js",
    from: "          await retireCompletedCommandTurnOnIdle(\n            eventSessionID,\n            defaultGoalOptions.maxRecentMessages,\n          )",
    to: "          currentRuntime().activeCommandTurns.delete(eventSessionID)",
    test: "test/host-lifecycle.test.js",
  },
  {
    name: "takeover preserves the observed execution context",
    file: "src/goal-plugin.js",
    from: "  if (!preserveExecutionContext) runtime.sessionExecutionContexts.delete(sessionID)",
    to: "  runtime.sessionExecutionContexts.delete(sessionID)",
    test: "test/host-lifecycle.test.js",
  },
  {
    name: "partial tool context preserves model and variant",
    file: "src/goal-plugin.js",
    from: "  const merged = {\n    ...previous,\n    ...observed,",
    to: "  const merged = {\n    ...observed,",
    test: "test/host-lifecycle.test.js",
  },
  {
    name: "authoritative host context clears stale variants",
    file: "src/goal-plugin.js",
    from: "      rememberSessionExecutionContext(sessionID, input, { replace: true })",
    to: "      rememberSessionExecutionContext(sessionID, input)",
    test: "test/host-lifecycle.test.js",
  },
  {
    name: "canonical tools contribute their execution context",
    file: "src/goal-plugin.js",
    from: "      executionContext: ctx,\n    })\n    const unavailable = inactiveGoalToolResult(\n      loadResult,\n      commandName,\n      isDisposed(),\n      commandRegistered,\n    )\n    if (unavailable) return serializeGoalToolResult",
    to: "      executionContext: undefined,\n    })\n    const unavailable = inactiveGoalToolResult(\n      loadResult,\n      commandName,\n      isDisposed(),\n      commandRegistered,\n    )\n    if (unavailable) return serializeGoalToolResult",
    test: "test/host-lifecycle.test.js",
  },
  {
    name: "tool-only mode receives an actionable contention hint",
    file: "src/goal-plugin.js",
    from: "  const retryTarget = commandRegistered\n    ?",
    to: "  const retryTarget = true\n    ?",
    test: "test/host-lifecycle.test.js",
  },
  {
    name: "passive state remains isolated to its session",
    file: "src/goal-plugin.js",
    from: "    const passive = runtime.passiveSessions.get(sessionID)\n    pruneExpiredPendingCommandTurns(sessionID)\n    const commandTurnInFlight =",
    to: "    const passive = runtime.passiveSessions.values().next().value\n    pruneExpiredPendingCommandTurns(sessionID)\n    const commandTurnInFlight =",
    test: "test/host-lifecycle.test.js",
  },
  {
    name: "expired pending passive command guards do not block takeover forever",
    file: "src/goal-plugin.js",
    from: "    pruneExpiredPendingCommandTurns(sessionID)\n    const commandTurnInFlight =",
    to: "    if (false) pruneExpiredPendingCommandTurns(sessionID)\n    const commandTurnInFlight =",
    test: "test/host-lifecycle.test.js",
  },
  {
    name: "only a fresh command may retry past an accepted passive command guard",
    file: "src/goal-plugin.js",
    from: "        freshCommandBoundary: true,",
    to: "        freshCommandBoundary: false,",
    test: "test/host-lifecycle.test.js",
  },
  {
    name: "passive session tombstones are retained until explicit takeover",
    file: "src/goal-plugin.js",
    from: "    runtime.passiveSessions.set(sessionID, entry)\n    if (!previous?.warned) {",
    to: "    runtime.passiveSessions.set(sessionID, entry)\n    while (runtime.passiveSessions.size > 1000) runtime.passiveSessions.delete(runtime.passiveSessions.keys().next().value)\n    if (!previous?.warned) {",
    test: "test/passive-retention.test.js",
  },
  {
    name: "ambient hooks never acquire a formerly contended session",
    file: "src/goal-plugin.js",
    from: "      (!retryPassive || commandTurnInFlight || Date.now() < passive.retryAt)",
    to: "      (false || commandTurnInFlight || Date.now() < passive.retryAt)",
    test: "test/host-lifecycle.test.js",
  },
  {
    name: "an active passive-command turn prevents lease takeover",
    file: "src/goal-plugin.js",
    from: "      (!retryPassive || commandTurnInFlight || Date.now() < passive.retryAt)",
    to: "      (!retryPassive || Date.now() < passive.retryAt)",
    test: "test/host-lifecycle.test.js",
  },
  {
    name: "passive slash commands cannot mutate goal state",
    file: "src/goal-plugin.js",
    from: '      if (loadResult.kind === "passive") {',
    to: "      if (false) {",
    test: "test/host-lifecycle.test.js",
  },
  {
    name: "passive command replies retain their denial provenance",
    file: "src/goal-plugin.js",
    from: "        commandTurn.passive = true",
    to: "        commandTurn.passive = false",
    test: "test/host-lifecycle.test.js",
  },
  {
    name: "passive legacy goal tools cannot invoke handlers",
    file: "src/goal-plugin.js",
    from: "    if (unavailable) return unavailable.message",
    to: "    if (false) return unavailable.message",
    test: "test/host-lifecycle.test.js",
  },
  {
    name: "passive canonical goal tools return the ownership error",
    file: "src/goal-plugin.js",
    from: "    if (unavailable) return serializeGoalToolResult(operation, unavailable)",
    to: "    if (false) return serializeGoalToolResult(operation, unavailable)",
    test: "test/host-lifecycle.test.js",
  },
  {
    name: "takeover preserves passive command security tombstones",
    file: "src/goal-plugin.js",
    from: "  if (!preserveCommandSecurity) {",
    to: "  if (true) {",
    test: "test/host-lifecycle.test.js",
  },
  {
    name: "late passive command replies stay excluded after takeover",
    file: "src/goal-plugin.js",
    from: "        if (controlCommandAssistant) {",
    to: "        if (false) {",
    test: "test/host-lifecycle.test.js",
  },
  {
    name: "goal tools register without an external helper",
    file: "src/goal-plugin.js",
    // v1.0.1 wave 5 (T40): re-anchored after `mirrorMode` was added as buildAgentTools' 7th
    // argument (CONTRACTS "Tool-description append ... (T21)" amendment, design SS4.6); the
    // property guarded is unchanged — hooks.tool must be the real wired-up tool table, not a stub.
    from: "    hooks.tool = buildAgentTools(\n      bundledToolHelper,\n      agentToolHandlers,\n      ensureSessionLoaded,\n      commandName,\n      () => runtime.disposed,\n      registerCommand,\n      mirrorMode,\n    )",
    to: "hooks.tool = {}",
    test: "test/goal-plugin.test.js",
  },
  {
    name: "a compaction summary ends the turn instead of being skipped",
    file: "src/goal-plugin.js",
    from: "    if (isCompactionAssistantMessage(message)) break",
    to: "    if (isCompactionAssistantMessage(message)) continue",
    test: "test/goal-plugin.test.js",
  },
  {
    name: "the turn's marker is read from its last text-bearing step",
    file: "src/goal-plugin.js",
    from: "    const text = getText(turn[i]?.parts)",
    to: "    const text = \"\"",
    test: "test/goal-plugin.test.js",
  },
  {
    name: "a turn is truncated only when the visibility window is full",
    file: "src/goal-plugin.js",
    from: "  if (limit <= 0 || list.length < limit || turn.length === 0) return false",
    to: "  if (limit <= 0 || turn.length === 0) return false",
    test: "test/goal-plugin.test.js",
  },
  {
    name: "a truncated turn does not charge the no-tool-call brake",
    file: "src/goal-plugin.js",
    from: "          !activationBoundary &&\n          !turnTruncated &&\n          Boolean(latestAssistant) &&",
    to: "          !activationBoundary &&\n          Boolean(latestAssistant) &&",
    test: "test/goal-plugin.test.js",
  },
  {
    name: "the plugin's own tools are not the turn's work",
    file: "src/goal-plugin.js",
    // Re-anchored at v1.0.1 wave-2 integration. T15 gave `messageHasWorkToolCall` an
    // `exempt` set for the mirror refresh, which turned the one-line `parts.some`
    // predicate into a block body; the guarded property is unchanged, so the mutant
    // still drops the plugin-own-tool exclusion and nothing else.
    from: "    return !isPluginOwnToolName(name) && !exemptNames.has(name)",
    to: "    return !exemptNames.has(name)",
    test: "test/goal-plugin.test.js",
  },
  {
    name: "a new billed step is told apart from a streaming update",
    file: "src/goal-plugin.js",
    from: "    current.input > previous.input ||",
    to: "    current.input >= previous.input ||",
    test: "test/goal-plugin.test.js",
  },
  {
    name: "spend already billed before a restart is not billed twice",
    file: "src/goal-plugin.js",
    from: "          !usageCountedBeforeRestart &&",
    to: "          true &&",
    test: "test/goal-plugin.test.js",
  },
  {
    name: "spend keeps accruing across a compaction boundary",
    file: "src/goal-plugin.js",
    from: "          goal.usage = addUsageDelta(goal.usage, currentUsage, previousUsage)",
    to: "          if (!staleForContext) goal.usage = addUsageDelta(goal.usage, currentUsage, previousUsage)",
    test: "test/goal-plugin.test.js",
  },
  {
    name: "a delegated child's tokens are charged to the delegating goal",
    file: "src/goal-plugin.js",
    from: "          ownGoal || (goalStates.size > 0 ? await goalForDelegatedSession(currentSessionID) : null)",
    to: "          ownGoal || null",
    test: "test/goal-plugin.test.js",
  },
  {
    name: "the context ceiling falls back to the model's own window",
    file: "src/goal-plugin.js",
    from: "  return toNonNegativeInteger(goal?.modelContextTokens)",
    to: "  return 0",
    test: "test/goal-plugin.test.js",
  },
  {
    name: "the shipped context-window default is auto-detect, not a constant",
    file: "src/goal-plugin.js",
    from: "  contextWindowTokens: 0,\n  minDelayMs: 1500,",
    to: "  contextWindowTokens: 200_000,\n  minDelayMs: 1500,",
    test: "test/goal-plugin.test.js",
  },
  {
    // The wire id is still `opencode-goal-plugin` in both halves, so a second
    // entry naming any other build of this plugin does not add a plugin — the
    // TUI runtime rejects the duplicate id (plugin/tui/runtime.ts:655) and the
    // sidebar silently never appears. Leaving a stale entry behind is therefore
    // a broken install, not an untidy one.
    name: "installing removes an older build's entry instead of colliding with it",
    file: "scripts/install.mjs",
    from: "    if (ours || isRelatedSpec(raw)) {",
    to: "    if (ours) {",
    test: "test/install.test.js",
  },
  {
    // A trailing comma is legal input (every global config file is read with
    // ConfigParse.jsonc), and it is a real byte in the text `applyEdits`
    // rewrites. Scanning the trailing-comma-BLANKED text made the last element
    // of such an array look unseparated, merged its deletion with the one
    // before it, and left an orphan `, ,` — a config OpenCode can no longer
    // parse, written by a command that exited 0.
    name: "the plugin-array editor sees a trailing comma as a real separator",
    file: "scripts/install.mjs",
    from: '    const forward = skipWhitespace(scan, end)\n    if (scan[forward] === ",") {',
    to: '    const forward = skipWhitespace(blankTrailingCommas(scan), end)\n    if (blankTrailingCommas(scan)[forward] === ",") {',
    test: "test/install.test.js",
  },
  {
    // The guard that makes an editor bug a refusal rather than a bricked
    // config: the rewrite must hold exactly the survivors plus the addition.
    name: "a rewrite is checked against the entries it was supposed to produce",
    file: "scripts/install.mjs",
    from: "  if (JSON.stringify(got) !== JSON.stringify(expected)) {",
    to: "  if (false) {",
    test: "test/install.test.js",
  },
  {
    name: "the terminal render carries the learned context ceiling",
    file: "src/goal-plugin.js",
    from: "    modelContextTokens: goal.modelContextTokens,\n    modelKey: goal.modelKey,\n",
    to: "",
    test: "test/goal-plugin.test.js",
  },
  // The seven todo-mirror mutation anchors (design §5.3)
  // Design §5.3 lists seven mutants; this region carries twelve records.
  //
  // Mutant 7 became TWO records. Its guard is byte-identical in the before- and
  // the after-hook, so one `/g` anchor matches twice and `occurrences === 1`
  // rejects it — mutating both at once would also prove nothing about which
  // hook the failing test caught. Each record is therefore selected by the code
  // that FOLLOWS its own guard: only the after-hook reads its sessionID
  // directly under its mode guard, so the positive lookahead selects that hook
  // and the negative one selects the before-hook. Both stay zero-width, so the
  // replacement still removes the guard alone.
  //
  // Four further anchors close gaps the wave-3 and wave-4 integrations recorded
  // as unowned: the tool.definition kill switch, the panel's exception-group
  // ORDER (the first record in this contract naming src/goal-sidebar-view.js —
  // the staging step below copies the whole of src/, so it needs no new wiring)
  // and both halves of T15's `exempt` parameter, the caller's mode gate and the
  // predicate that honours the set.
  //
  // Every killing unit named below was observed failing under its own mutant,
  // not inferred from the design.
  {
    name: "the todo mirror mutates the host's args object rather than replacing it",
    file: "src/goal-plugin.js",
    // The one wrong implementation every naive test accepts. The host keeps its
    // own reference to the args bag before triggering the hook, so replacing the
    // bag is silently dropped and the model's unmirrored list reaches the tool.
    // Killed by "todowrite args are rewritten in place, because a reassigned
    // args object is dropped by the host" (unit 7).
    from: "output.args.todos = rows",
    to: "output.args = { ...output.args, todos: rows }",
    test: "test/goal-plugin.test.js",
  },
  {
    name: "an unverified done action never mirrors as completed",
    file: "src/goal-plugin.js",
    // The CEV gate, in the mirror: a `done` status the plan's own verdict has
    // not confirmed must render as work still in flight, never as a tick.
    // Killed by "a done action without a passing verdict mirrors as in-progress,
    // not completed" (unit 2).
    from: 'return planActionVerified(action) ? "completed" : "in_progress"',
    to: 'return action.status === "done" ? "completed" : "in_progress"',
    test: "test/goal-plugin.test.js",
  },
  {
    name: "freshness is stamped only after the write landed",
    file: "src/goal-plugin.js",
    // Single call site, in tool.execute.after. Reading the before-hook's box
    // instead stamps a list the host may never have written — the host decodes
    // the args and asks for permission between the two hooks, and either can
    // abort — which would suppress the very nudge that repairs the panel.
    // Killed by "the mirror is stamped fresh in the after-hook, from the args
    // that were written" (unit 17).
    from: "stampMirror(goal, input.args, now)",
    to: "stampMirror(goal, output.args, now)",
    test: "test/goal-plugin.test.js",
  },
  {
    name: "every mirrored row carries a priority",
    file: "src/goal-plugin.js",
    // A row without a priority is a row the host renders in an arbitrary slot,
    // so the high slot stops tracking the first row the model must act on.
    // Killed by "the projector spends the high slot on the first row the model
    // still has to act on" (unit 4).
    from: "priority: mirrorRowPriority(action, index)",
    to: "priority: undefined",
    test: "test/goal-plugin.test.js",
  },
  {
    // RegExp anchor: this set grows, so anchor on the declaration.
    // Precedent: REPLAY_SAFE_OPERATIONS above.
    name: "a mirror refresh is bookkeeping, not work",
    file: "src/goal-plugin.js",
    // Emptying the set makes the plugin's own panel refresh count as the turn's
    // work, so the no-tool-call brake never fires on a model that only redraws
    // its todo list. Killed by "a turn whose only tool call was a mirror refresh
    // does not clear the tool-free strike" (unit 27).
    from: /const MIRROR_TOOL_NAMES = new Set\(\[[^\]]*\]\)/,
    to: "const MIRROR_TOOL_NAMES = new Set([])",
    test: "test/goal-plugin.test.js",
  },
  {
    name: "an empty todowrite never reaches the host as an empty list",
    file: "src/goal-plugin.js",
    // The data-loss mutant (X1): deleting the empty-call interception wipes the
    // user's panel, and it is exactly what revision 1 of this design shipped.
    // Killed by "an empty todowrite in a stopped-goal session re-emits the last
    // mirrored rows" (unit 43) and "an empty todowrite before a plan exists
    // re-emits the last mirrored rows, and passes through when nothing was ever
    // mirrored" (unit 44). Design §5.3 names unit 13 here; unit 13 exercises the
    // LIVE-plan branch, which re-projects instead of re-emitting and so cannot
    // see this line — 43 and 44 are the units that actually kill it.
    from: "output.args.todos = goal.mirror.rows",
    to: "return",
    test: "test/goal-plugin.test.js",
  },
  {
    name: "the mirror's before-hook acts only on todowrite",
    file: "src/goal-plugin.js",
    // Half of design §5.3's mutant 7 (X3): both hooks fire for EVERY tool. Drop
    // this gate and the plugin writes a `todos` property into bash's arguments,
    // so every tool call in the session fails the host's argument decode. The
    // negative lookahead is zero-width and selects the before-hook, whose guard
    // is NOT followed directly by the mode guard and the sessionID read.
    from: /if \(input\.tool !== "todowrite"\) return(?!\r?\n +if \(mirrorMode === "off"\) return\r?\n +const sessionID)/,
    to: "",
    test: "test/goal-plugin.test.js", // kills unit 47
  },
  {
    name: "the mirror's after-hook acts only on todowrite",
    file: "src/goal-plugin.js",
    // The other half of mutant 7. Drop this gate and any tool at all stamps the
    // mirror fresh and gets the mirror note appended to its own result.
    // The positive lookahead is the exact complement of the record above.
    from: /if \(input\.tool !== "todowrite"\) return(?=\r?\n +if \(mirrorMode === "off"\) return\r?\n +const sessionID)/,
    to: "",
    test: "test/goal-plugin.test.js", // kills unit 46
  },
  {
    name: "the todowrite description suffix obeys the mirror kill switch",
    file: "src/goal-plugin.js",
    // Gap left open by wave 3: no anchor covered the tool.definition hook. The
    // guard's text repeats in three hooks, so the anchor carries the following
    // line, which is unique to this one. With the gate gone, `mirrorTodos: "off"`
    // still rewrites the host's tool description — the one thing "off" promises
    // it will never do. Killed by "the todowrite description carries the mirror
    // clause whenever mirrorTodos is on" (unit 30) and by the wave-3 off-mode
    // seam unit.
    from:
      'if (mirrorMode === "off") return\n      if (!output || typeof output.description !== "string") return',
    to: 'if (!output || typeof output.description !== "string") return',
    test: "test/goal-plugin.test.js",
  },
  {
    name: "the panel's exception list is ordered by what a human must act on first",
    file: "src/goal-sidebar-view.js",
    // Gap left open by wave 4: this contract had no record for the panel file at
    // all, so the exception list's group ORDER was guarded only by the live
    // suite. Swapping the first two groups puts blockers above completions that
    // still need evidence, which is the wrong end of the list to read first.
    // Killed by "a fresh mirror renders only the actions that need attention"
    // (unit 33) and by "the exception list keeps plan order within each group and
    // caps at MAX_PANEL_ACTIONS". The wave-4 cross-half parity unit (38) does NOT
    // kill it: its fixture carries no blocked action, so the swap is invisible
    // there.
    from:
      '  (action) => action.status === "done" && !action.verified,\n  (action) => action.status === "blocked",',
    to:
      '  (action) => action.status === "blocked",\n  (action) => action.status === "done" && !action.verified,',
    test: "test/goal-sidebar-panel.test.js",
  },
  {
    name: "the payload publishes the server's own CEV verdict, not a re-derivation",
    file: "src/goal-plugin.js",
    // The v1.0.1 review finding, in one mutant. The panel cannot re-derive
    // verification: the payload carries no claim and no evidence, and
    // `goal_plan_set` accepts a `done` action with a passing verdict and neither.
    // Replacing the call with the derivation a consumer WOULD reach for turns
    // that action green and drops it from the exception list, while the server's
    // own progress count and mirrored todo row still call it unverified. Killed
    // by "a done action with a passing verdict but no ledger is an exception on
    // the panel, as it is on the wire".
    from: "verified: planActionVerified(action),",
    to: 'verified: action.status === "done" && action.verdict === "pass",',
    test: "test/goal-sidebar-panel.test.js",
  },
  {
    name: "the panel trusts the published verdict over its own derivation",
    file: "src/goal-sidebar-view.js",
    // The other half of the same property: publishing the boolean is useless if
    // the panel keeps re-deriving it. With this mutant the wire is correct and
    // the panel still hides an unsubstantiated completion. The mutant keeps the
    // v2 fallback intact, so it is the PREFERENCE that is under test, not the
    // fallback.
    from: 'typeof raw.verified === "boolean" ? raw.verified : verdict === "pass"',
    to: 'verdict === "pass"',
    test: "test/goal-sidebar-panel.test.js",
  },
  {
    name: "nothing is exempt from the tool-free strike when mirroring is off",
    file: "src/goal-plugin.js",
    // T15's `exempt` parameter, caller half. Exempting todowrite unconditionally
    // would make v1.0.0's behaviour unreachable: with the mirror off, a todowrite
    // is the model's own work and must keep resetting the no-tool-call brake.
    // Killed by "todowrite still counts as work when mirroring is off" (unit 28).
    from: 'mirrorMode === "plan" ? MIRROR_TOOL_NAMES : NO_EXEMPT_TOOL_NAMES',
    to: "MIRROR_TOOL_NAMES",
    test: "test/goal-plugin.test.js",
  },
  {
    name: "the work predicate honours the exempt set it was handed",
    file: "src/goal-plugin.js",
    // T15's `exempt` parameter, predicate half — the complement of "the plugin's
    // own tools are not the turn's work" above, which mutates the other operand
    // of the same line. Ignoring the set silently restores the pre-v1.0.1 brake,
    // so a goal whose model only refreshes the panel never pauses.
    // Killed by "a turn whose only tool call was a mirror refresh does not clear
    // the tool-free strike" (unit 27).
    from: "    return !isPluginOwnToolName(name) && !exemptNames.has(name)",
    to: "    return !isPluginOwnToolName(name)",
    test: "test/goal-plugin.test.js",
  },

]

try {
  await mkdir(join(root, "node_modules"), { recursive: true })
  await Promise.all([
    cp(join(repository, "src"), join(root, "src"), { recursive: true }),
    cp(join(repository, "test"), join(root, "test"), { recursive: true }),
    // The installer lives in scripts/ and imports nothing but node: builtins,
    // so a mutant can be planted there exactly as in src/.
    cp(join(repository, "scripts"), join(root, "scripts"), { recursive: true }),
    cp(join(repository, "node_modules", "zod"), join(root, "node_modules", "zod"), {
      recursive: true,
    }),
    writeFile(join(root, "package.json"), JSON.stringify({ private: true, type: "module" })),
  ])

  const baselineTests = [...new Set(mutants.map(({ test }) => test))]
  for (const testFile of baselineTests) {
    const result = spawnSync(process.execPath, ["--test", testFile], { cwd: root, encoding: "utf8" })
    assert.equal(result.status, 0, `mutation baseline failed for ${testFile}\n${result.stdout}\n${result.stderr}`)
  }

  for (const mutant of mutants) {
    const path = join(root, mutant.file)
    const original = await readFile(path, "utf8")
    const { occurrences, mutate } = locateMutation(mutant, original)
    assert.equal(occurrences, 1, staleAnchorMessage(mutant, occurrences))
    const mutated = mutate()
    assert.notEqual(
      mutated,
      original,
      `${mutant.name}: anchor matched ${mutant.file} but the replacement left the source\n` +
        `unchanged, so nothing was actually mutated and the test below would pass for the\n` +
        `wrong reason. Check the 'to' replacement in scripts/mutation-contract.mjs.`,
    )
    await writeFile(path, mutated)

    const result = spawnSync(process.execPath, ["--test", mutant.test], { cwd: root, encoding: "utf8" })
    assert.notEqual(result.status, 0, `${mutant.name}: test suite survived the mutant`)
    await writeFile(path, original)
    console.log(`killed mutant: ${mutant.name}`)
  }

  console.log(`mutation contract passed (${mutants.length}/${mutants.length} critical mutants killed)`)
} finally {
  await rm(root, { recursive: true, force: true })
}
