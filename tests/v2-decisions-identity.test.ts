import { describe, expect, test } from "bun:test"
import { resolveConfig } from "../src/config.ts"
import { parseSystemOneReview, SYSTEM_ONE_QUESTIONS } from "../src/system-one/review.ts"

function validResponse(model: string): Record<string, unknown> {
  const answers = Object.fromEntries(
    Object.entries(SYSTEM_ONE_QUESTIONS).map(([name, question]) => {
      if (question.type === "noul") return [name, { type: "noul", noul: 0 }]
      const criteria = Object.keys(question.criteria)
      const choice = criteria[0]!
      return [
        name,
        {
          type: "choice",
          choice,
          confidence: 1,
          probabilities: Object.fromEntries(criteria.map((key) => [key, key === choice ? 1 : 0])),
        },
      ]
    }),
  )
  return { model, answers }
}

const decisionsIdentity = { identityMode: "decisions" as const }

describe("V2 Decisions response identity", () => {
  test("accepts the exact Zen native ID and exact or valid dated OpenRouter IDs", () => {
    const cases = [
      ["opencode/jev-1.13-free", "jev-1.13-free"],
      ["openrouter/vendor/model", "vendor/model"],
      ["openrouter/vendor/model", "vendor/model-20260228"],
      ["openrouter/vendor/model-20260917", "vendor/model-20260917"],
    ] as const

    for (const [configuredModel, returnedModel] of cases) {
      expect(
        parseSystemOneReview(
          validResponse(returnedModel),
          { ...resolveConfig(undefined), model: configuredModel },
          decisionsIdentity,
        ),
      ).toBeDefined()
    }
  })

  test("accepts only the observed Mercury free-alias removal", () => {
    const config = {
      ...resolveConfig(undefined),
      model: "openrouter/inception/mercury-decide:free",
    }
    expect(
      parseSystemOneReview(validResponse("inception/mercury-decide"), config, decisionsIdentity),
    ).toBeDefined()
    expect(
      parseSystemOneReview(
        validResponse("inception/mercury-decide-20261013"),
        config,
        decisionsIdentity,
      ),
    ).toBeDefined()
  })

  test("rejects vendor, sibling, version, arbitrary alias, and invalid-date identities", () => {
    const cases = [
      ["openrouter/vendor/model", "other/model"],
      ["openrouter/vendor/model", "vendor/model-sibling"],
      ["openrouter/vendor/model", "vendor/model:free"],
      ["openrouter/vendor/model", "vendor/model-20260230"],
      ["openrouter/vendor/model-20260917", "vendor/model-20260917-20261013"],
      ["openrouter/acme/model:free", "acme/model"],
      ["openrouter/acme/model:free", "acme/model-20261013"],
      ["openrouter/vendor/model:other", "vendor/model:other-20261013"],
      ["opencode/jev-1.13-free", "jev-1.13-free-20260228"],
    ] as const

    for (const [configuredModel, returnedModel] of cases) {
      expect(
        parseSystemOneReview(
          validResponse(returnedModel),
          { ...resolveConfig(undefined), model: configuredModel },
          decisionsIdentity,
        ),
      ).toBeUndefined()
    }
  })

  test("treats unmapped colon suffixes as exact-only identifiers", () => {
    const config = { ...resolveConfig(undefined), model: "openrouter/vendor/model:other" }
    expect(
      parseSystemOneReview(validResponse("vendor/model:other"), config, decisionsIdentity),
    ).toBeDefined()

    for (const returnedModel of [
      "vendor/model:other-20261013",
      "vendor/model",
      "vendor/model-sibling",
    ]) {
      expect(
        parseSystemOneReview(validResponse(returnedModel), config, decisionsIdentity),
      ).toBeUndefined()
    }
  })

  test("keeps the legacy identity rule when strict mode is omitted", () => {
    const config = { ...resolveConfig(undefined), model: "opencode/jev-1.13" }
    expect(parseSystemOneReview(validResponse("jev-unrelated-revision"), config)).toBeDefined()
  })
})
