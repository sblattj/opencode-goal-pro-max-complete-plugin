const SHAPE_ERROR_PATTERNS = [
  /(?:missing|required).*(?:sessionID|path|body|query)/i,
  /(?:unknown|unrecognized|unexpected|invalid).*(?:sessionID|path|body|query|argument|field|key)/i,
  /(?:expected|must be).*(?:object|path|body|query|sessionID)/i,
  /(?:validation|schema|invalid input|invalid argument)/i,
]

// Only read-only operations may be retried with another argument shape. A
// TypeError can be raised after a mutating SDK call has already reached the
// host, so replaying create/prompt/update/delete/abort could duplicate side effects.
const REPLAY_SAFE_OPERATIONS = new Set(["messages", "get", "children", "status", "todo"])

function isArgumentShapeError(error) {
  if (!(error instanceof TypeError)) return false
  const message = String(error.message || "")
  return SHAPE_ERROR_PATTERNS.some((pattern) => pattern.test(message))
}

function unwrapData(response) {
  return response && typeof response === "object" && "data" in response
    ? response.data
    : response
}

/**
 * Present both historical and current OpenCode session SDKs through one API.
 * A successful shape is remembered independently for every operation.
 */
export function createOpenCodeSessionApi(client, options = {}) {
  if (!client?.session || typeof client.session !== "object") {
    throw new TypeError("OpenCode client.session is required")
  }

  const preferredShape = options.preferredShape || "flat"
  if (preferredShape !== "flat" && preferredShape !== "legacy") {
    throw new TypeError('preferredShape must be "flat" or "legacy"')
  }
  const shapes = new Map()

  async function invoke(operation, flatInput, legacyInput) {
    const method = client.session[operation]
    if (typeof method !== "function") {
      throw new TypeError(`OpenCode client.session.${operation} is not available`)
    }

    const knownShape = shapes.get(operation)
    const firstShape = knownShape || preferredShape
    const firstInput = firstShape === "flat" ? flatInput : legacyInput
    try {
      const response = await method.call(client.session, firstInput)
      shapes.set(operation, firstShape)
      return unwrapData(response)
    } catch (error) {
      if (knownShape || !REPLAY_SAFE_OPERATIONS.has(operation) || !isArgumentShapeError(error)) {
        throw error
      }
      const fallbackShape = firstShape === "flat" ? "legacy" : "flat"
      const fallbackInput = fallbackShape === "flat" ? flatInput : legacyInput
      const response = await method.call(client.session, fallbackInput)
      shapes.set(operation, fallbackShape)
      return unwrapData(response)
    }
  }

  return Object.freeze({
    messages(sessionID, options = {}) {
      return invoke(
        "messages",
        { sessionID, ...options },
        { path: { id: sessionID }, query: options },
      )
    },
    children(sessionID) {
      return invoke("children", { sessionID }, { path: { id: sessionID } })
    },
    status() {
      return invoke("status", {}, { path: {} })
    },
    promptAsync(sessionID, input = {}) {
      return invoke(
        "promptAsync",
        { sessionID, ...input },
        { path: { id: sessionID }, body: input },
      )
    },
    createChild(parentID, input = {}) {
      const body = { ...input, parentID }
      return invoke("create", body, { body })
    },
    prompt(sessionID, input = {}) {
      return invoke(
        "prompt",
        { sessionID, ...input },
        { path: { id: sessionID }, body: input },
      )
    },
    update(sessionID, input = {}) {
      return invoke(
        "update",
        { sessionID, ...input },
        { path: { id: sessionID }, body: input },
      )
    },
    get(sessionID) {
      return invoke("get", { sessionID }, { path: { id: sessionID } })
    },
    // v1.0.1 T38: GET /session/{id}/todo -> Array<Todo>, used for the
    // read-only <existing_todos> offer on /goal set (design §4.3(c)).
    todo(sessionID) {
      return invoke("todo", { sessionID }, { path: { id: sessionID } })
    },
    // POST /session/{id}/summarize compacts the session. Mutating: never add it
    // to REPLAY_SAFE_OPERATIONS, a replay would compact twice. The host call
    // stays pending until its whole agent run ends; callers must not await it.
    summarize(sessionID, { providerID, modelID } = {}) {
      return invoke(
        "summarize",
        { sessionID, providerID, modelID },
        { path: { id: sessionID }, body: { providerID, modelID } },
      )
    },
    // DELETE /session/{id}/message/{messageID}. Mutating: never add it to
    // REPLAY_SAFE_OPERATIONS. The host refuses it while the session is busy, and
    // the generated SDK resolves such an answer as `{ error }`, so that throws here.
    async deleteMessage(sessionID, messageID) {
      let response
      if (typeof client.session.deleteMessage === "function") {
        response = await invoke(
          "deleteMessage",
          { sessionID, messageID },
          { path: { id: sessionID, messageID } },
        )
      } else {
        // The generated v1 client the host hands to plugins has no method for this
        // route. Its session object does hold the configured transport (`_client`,
        // with the server URL, auth and directory), which is how its own methods
        // call the route next to this one, `message`.
        const transport = client.session._client
        if (typeof transport?.delete !== "function") {
          throw new TypeError("OpenCode client.session.deleteMessage is not available")
        }
        response = unwrapData(
          await transport.delete({
            url: "/session/{id}/message/{messageID}",
            path: { id: sessionID, messageID },
          }),
        )
      }
      if (response && typeof response === "object" && response.error) {
        const detail = response.error?.data?.message || response.error?.name || response.error?.message
        throw new Error(`Host refused to delete message ${messageID}: ${detail || JSON.stringify(response.error)}`)
      }
      return response
    },
    delete(sessionID) {
      return invoke("delete", { sessionID }, { path: { id: sessionID } })
    },
    abort(sessionID) {
      return invoke("abort", { sessionID }, { path: { id: sessionID } })
    },
  })
}

export const sessionApiInternals = Object.freeze({ isArgumentShapeError, unwrapData })
