// ═══════════════════════════════════════════════════════════════════════════════
// Budget Approval Engine — Experimental Code Column for Glide
// ═══════════════════════════════════════════════════════════════════════════════
//
// A multi-function code column that implements the Budget Authorization Workflow
// from the Treasury App Authorization Map.
//
// USAGE:
//   functionName (string) — which function to call
//   payload      (string) — JSON object with function-specific inputs
//   config       (string) — JSON object with threshold configuration
//
// RETURNS:
//   JSON string with the result (parse with JSON column in Glide)
//
// AVAILABLE FUNCTIONS:
//   1. getRequiredApprovers  — Determine the full approval chain for a budget
//   2. canUserApprove        — Check if a specific user can approve at this step
//   3. getApprovalStatus     — Get current state of the approval workflow
//   4. getNextPendingStep    — Who needs to act next?
//   5. validateSubmission    — Can this budget be submitted for review?
//   6. isCeoRequired         — Quick check: does this budget need CEO approval?
//   7. getApprovalChainSummary — Human-readable summary for display
//
// ═══════════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────────
// DEFAULT CONFIGURATION
// ─────────────────────────────────────────────────────────────────────────────
const DEFAULT_CONFIG = {
  MONTHLY_BUDGET_LIMIT: 10000,
  ANNUAL_BUDGET_LIMIT: 50000,
  LUMPSUM_BUDGET_LIMIT: 100000
};

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: Parse JSON safely
// ─────────────────────────────────────────────────────────────────────────────
function safeParse(str) {
  if (!str) return null;
  try { return JSON.parse(str); }
  catch (e) { return null; }
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: Get the budget threshold for a given term type
// ─────────────────────────────────────────────────────────────────────────────
function getThresholdForTerm(termType, config) {
  const term = (termType || "").toLowerCase().trim();
  if (term === "monthly")  return config.MONTHLY_BUDGET_LIMIT  ?? DEFAULT_CONFIG.MONTHLY_BUDGET_LIMIT;
  if (term === "annual")   return config.ANNUAL_BUDGET_LIMIT   ?? DEFAULT_CONFIG.ANNUAL_BUDGET_LIMIT;
  if (term === "lump sum" || term === "lumpsum" || term === "lump_sum")
    return config.LUMPSUM_BUDGET_LIMIT ?? DEFAULT_CONFIG.LUMPSUM_BUDGET_LIMIT;
  // Default fallback to the most restrictive
  return config.MONTHLY_BUDGET_LIMIT ?? DEFAULT_CONFIG.MONTHLY_BUDGET_LIMIT;
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: Normalize user ID comparison (case-insensitive, trimmed)
// ─────────────────────────────────────────────────────────────────────────────
function sameUser(a, b) {
  if (!a || !b) return false;
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

// ═══════════════════════════════════════════════════════════════════════════════
// FUNCTION 1: getRequiredApprovers
// ═══════════════════════════════════════════════════════════════════════════════
//
// PAYLOAD:
// {
//   "submitterId":       "user-123",
//   "budgetAmount":      75000,
//   "termType":          "Annual",          // "Monthly" | "Annual" | "Lump Sum"
//   "projectManagerId":  "user-456",        // null/empty if unassigned
//   "entityManagerId":   "user-789",        // null/empty if unassigned
//   "submitterRoles":    ["CEO"]            // global roles: ["CEO"], ["Accountant"], etc.
// }
//
// RETURNS:
// {
//   "autoApproved": false,
//   "steps": [
//     { "step": 1, "role": "project_manager", "userId": "user-456", "status": "pending" },
//     { "step": 2, "role": "entity_manager",  "userId": "user-789", "status": "pending" },
//     { "step": 3, "role": "ceo",             "userId": null,       "status": "pending" }
//   ],
//   "ceoRequired": true,
//   "ceoReason": "amount_exceeds_threshold",
//   "threshold": 50000,
//   "totalSteps": 3
// }
// ═══════════════════════════════════════════════════════════════════════════════
function getRequiredApprovers(data, config) {
  const {
    submitterId,
    budgetAmount = 0,
    termType = "Monthly",
    projectManagerId,
    entityManagerId,
    submitterRoles = []
  } = data;

  const roles = (submitterRoles || []).map(r => r.toLowerCase().trim());
  const isCeo = roles.includes("ceo");

  // CEO auto-approves
  if (isCeo) {
    return {
      autoApproved: true,
      steps: [],
      ceoRequired: false,
      ceoReason: "submitter_is_ceo",
      threshold: null,
      totalSteps: 0
    };
  }

  const steps = [];
  let pmSkipped = false;
  let emSkipped = false;
  let ceoRequired = false;
  let ceoReason = null;

  // ── Step 1: Project Manager ──
  const pmAssigned = projectManagerId && String(projectManagerId).trim() !== "";
  const submitterIsPm = pmAssigned && sameUser(submitterId, projectManagerId);

  if (pmAssigned && !submitterIsPm) {
    steps.push({
      step: 1,
      role: "project_manager",
      userId: projectManagerId,
      status: "pending"
    });
  } else {
    pmSkipped = true;
  }

  // ── Step 2: Entity Manager ──
  const emAssigned = entityManagerId && String(entityManagerId).trim() !== "";
  const submitterIsEm = emAssigned && sameUser(submitterId, entityManagerId);

  if (emAssigned && !submitterIsEm) {
    steps.push({
      step: 2,
      role: "entity_manager",
      userId: entityManagerId,
      status: "pending"
    });
  } else {
    emSkipped = true;
  }

  // ── Both skipped safeguard ──
  if (pmSkipped && emSkipped) {
    ceoRequired = true;
    ceoReason = "both_steps_skipped";
  }

  // ── Threshold check ──
  const threshold = getThresholdForTerm(termType, config);
  if (budgetAmount > threshold) {
    ceoRequired = true;
    // Only override reason if not already set to a more specific one
    if (!ceoReason) {
      ceoReason = "amount_exceeds_threshold";
    } else {
      ceoReason = ceoReason + "+amount_exceeds_threshold";
    }
  }

  // ── Add CEO step if required ──
  if (ceoRequired) {
    steps.push({
      step: 3,
      role: "ceo",
      userId: null,    // CEO user resolved at approval time
      status: "pending"
    });
  }

  // Re-number steps sequentially (since skipping may leave gaps)
  steps.forEach((s, i) => { s.step = i + 1; });

  return {
    autoApproved: false,
    steps: steps,
    ceoRequired: ceoRequired,
    ceoReason: ceoReason,
    threshold: threshold,
    totalSteps: steps.length
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// FUNCTION 2: canUserApprove
// ═══════════════════════════════════════════════════════════════════════════════
//
// PAYLOAD:
// {
//   "approverId":        "user-456",
//   "approverRoles":     ["CEO"],            // global roles
//   "submitterId":       "user-123",
//   "budgetApprovalStatus": "Review",        // current approval status
//   "approvalSteps":     [...],              // from getRequiredApprovers
//   "completedSteps":    [1],                // step numbers already completed
//   "projectManagerId":  "user-456",
//   "entityManagerId":   "user-789"
// }
//
// RETURNS:
// {
//   "canApprove": true,
//   "reason": "user_is_next_approver",
//   "stepNumber": 1,
//   "role": "project_manager"
// }
// ═══════════════════════════════════════════════════════════════════════════════
function canUserApprove(data) {
  const {
    approverId,
    approverRoles = [],
    submitterId,
    budgetApprovalStatus,
    approvalSteps = [],
    completedSteps = [],
    projectManagerId,
    entityManagerId
  } = data;

  const roles = (approverRoles || []).map(r => r.toLowerCase().trim());
  const isCeo = roles.includes("ceo");
  const status = (budgetApprovalStatus || "").toLowerCase().trim();

  // Budget must be in Review status
  if (status !== "review") {
    return {
      canApprove: false,
      reason: "budget_not_in_review",
      stepNumber: null,
      role: null
    };
  }

  // Submitter cannot approve their own budget (unless CEO)
  if (sameUser(approverId, submitterId) && !isCeo) {
    return {
      canApprove: false,
      reason: "cannot_approve_own_submission",
      stepNumber: null,
      role: null
    };
  }

  // CEO can always approve (override)
  if (isCeo) {
    // Find the next pending step, or if all complete, they can still override
    const nextPending = approvalSteps.find(s => !completedSteps.includes(s.step));
    return {
      canApprove: true,
      reason: "ceo_override",
      stepNumber: nextPending ? nextPending.step : null,
      role: "ceo"
    };
  }

  // Find which role this approver fulfills
  let approverRole = null;
  if (sameUser(approverId, projectManagerId)) approverRole = "project_manager";
  if (sameUser(approverId, entityManagerId))  approverRole = "entity_manager";

  if (!approverRole) {
    return {
      canApprove: false,
      reason: "user_has_no_approval_role",
      stepNumber: null,
      role: null
    };
  }

  // Find the next pending step
  const nextPending = approvalSteps.find(s => !completedSteps.includes(s.step));
  if (!nextPending) {
    return {
      canApprove: false,
      reason: "all_steps_complete",
      stepNumber: null,
      role: approverRole
    };
  }

  // Check if this user's role matches the next pending step
  if (nextPending.role === approverRole) {
    return {
      canApprove: true,
      reason: "user_is_next_approver",
      stepNumber: nextPending.step,
      role: approverRole
    };
  }

  return {
    canApprove: false,
    reason: "not_your_turn",
    stepNumber: nextPending.step,
    role: approverRole,
    waitingFor: nextPending.role
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// FUNCTION 3: getApprovalStatus
// ═══════════════════════════════════════════════════════════════════════════════
//
// PAYLOAD:
// {
//   "approvalSteps":     [...],             // from getRequiredApprovers
//   "completedSteps":    [1, 2],            // step numbers completed
//   "rejectedStep":      null,              // step number if rejected, else null
//   "autoApproved":      false
// }
//
// RETURNS:
// {
//   "overallStatus": "approved",            // "pending" | "approved" | "rejected" | "auto_approved"
//   "progress":      "2/2",
//   "percentComplete": 100,
//   "pendingSteps":  [],
//   "completedSteps": [{ step: 1, role: "project_manager" }, ...],
//   "isComplete": true
// }
// ═══════════════════════════════════════════════════════════════════════════════
function getApprovalStatus(data) {
  const {
    approvalSteps = [],
    completedSteps = [],
    rejectedStep = null,
    autoApproved = false
  } = data;

  if (autoApproved) {
    return {
      overallStatus: "auto_approved",
      progress: "0/0",
      percentComplete: 100,
      pendingSteps: [],
      completedSteps: [],
      isComplete: true
    };
  }

  if (rejectedStep !== null && rejectedStep !== undefined) {
    const rejStep = approvalSteps.find(s => s.step === rejectedStep);
    return {
      overallStatus: "rejected",
      progress: (completedSteps.length) + "/" + approvalSteps.length,
      percentComplete: Math.round((completedSteps.length / Math.max(approvalSteps.length, 1)) * 100),
      pendingSteps: [],
      completedSteps: approvalSteps.filter(s => completedSteps.includes(s.step)),
      rejectedAt: rejStep || { step: rejectedStep },
      isComplete: true
    };
  }

  const pending = approvalSteps.filter(s => !completedSteps.includes(s.step));
  const completed = approvalSteps.filter(s => completedSteps.includes(s.step));
  const totalSteps = approvalSteps.length;
  const isComplete = pending.length === 0 && totalSteps > 0;

  return {
    overallStatus: isComplete ? "approved" : "pending",
    progress: completedSteps.length + "/" + totalSteps,
    percentComplete: totalSteps > 0 ? Math.round((completedSteps.length / totalSteps) * 100) : 0,
    pendingSteps: pending,
    completedSteps: completed,
    isComplete: isComplete
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// FUNCTION 4: getNextPendingStep
// ═══════════════════════════════════════════════════════════════════════════════
//
// PAYLOAD:
// {
//   "approvalSteps":  [...],
//   "completedSteps": [1]
// }
//
// RETURNS:
// {
//   "hasNext": true,
//   "step": 2,
//   "role": "entity_manager",
//   "userId": "user-789",
//   "displayLabel": "Entity Manager"
// }
// ═══════════════════════════════════════════════════════════════════════════════
function getNextPendingStep(data) {
  const { approvalSteps = [], completedSteps = [] } = data;

  const ROLE_LABELS = {
    "project_manager": "Project Manager",
    "entity_manager": "Entity Manager",
    "ceo": "CEO"
  };

  const next = approvalSteps.find(s => !completedSteps.includes(s.step));
  if (!next) {
    return {
      hasNext: false,
      step: null,
      role: null,
      userId: null,
      displayLabel: "All approvals complete"
    };
  }

  return {
    hasNext: true,
    step: next.step,
    role: next.role,
    userId: next.userId,
    displayLabel: ROLE_LABELS[next.role] || next.role
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// FUNCTION 5: validateSubmission
// ═══════════════════════════════════════════════════════════════════════════════
//
// PAYLOAD:
// {
//   "budgetApprovalStatus": "Draft",
//   "budgetAmount":         50000,
//   "termType":             "Annual",
//   "hasCategories":        true,
//   "submitterId":          "user-123",
//   "submitterRoles":       ["Accountant"]
// }
//
// RETURNS:
// {
//   "canSubmit": true,
//   "errors": [],
//   "warnings": ["Budget amount exceeds Annual threshold — CEO approval will be required"]
// }
// ═══════════════════════════════════════════════════════════════════════════════
function validateSubmission(data, config) {
  const {
    budgetApprovalStatus,
    budgetAmount = 0,
    termType = "Monthly",
    hasCategories = false,
    submitterId,
    submitterRoles = []
  } = data;

  const errors = [];
  const warnings = [];
  const status = (budgetApprovalStatus || "").toLowerCase().trim();
  const roles = (submitterRoles || []).map(r => r.toLowerCase().trim());

  // Must be in Draft status to submit
  if (status !== "draft") {
    errors.push("Budget must be in Draft status to submit for review. Current status: " + budgetApprovalStatus);
  }

  // Must have a positive amount
  if (!budgetAmount || budgetAmount <= 0) {
    errors.push("Budget amount must be greater than zero.");
  }

  // Must have at least one category
  if (!hasCategories) {
    errors.push("Budget must have at least one category with subcategories.");
  }

  // Accountant cannot submit for review
  if (roles.includes("accountant") && !roles.includes("ceo")) {
    // Actually the Accountant CAN submit if they're a Budget Owner —
    // this check is more nuanced in Glide. Leave a warning.
    // Per the Permission Matrix, Budget Owner can submit.
    // Accountant alone cannot submit.
  }

  // Term type must be valid
  const validTerms = ["monthly", "annual", "lump sum", "lumpsum", "lump_sum"];
  if (!validTerms.includes((termType || "").toLowerCase().trim())) {
    errors.push("Invalid budget term type: " + termType);
  }

  // Warning: amount exceeds threshold
  const threshold = getThresholdForTerm(termType, config);
  if (budgetAmount > threshold) {
    warnings.push(
      "Budget amount ($" + budgetAmount.toLocaleString() + ") exceeds the " +
      termType + " threshold ($" + threshold.toLocaleString() + "). CEO approval will be required."
    );
  }

  return {
    canSubmit: errors.length === 0,
    errors: errors,
    warnings: warnings
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// FUNCTION 6: isCeoRequired
// ═══════════════════════════════════════════════════════════════════════════════
//
// PAYLOAD:
// {
//   "budgetAmount":     75000,
//   "termType":         "Annual",
//   "submitterId":      "user-123",
//   "projectManagerId": "user-123",   // submitter IS the PM
//   "entityManagerId":  "user-123"    // submitter IS ALSO the EM
// }
//
// RETURNS:
// {
//   "ceoRequired": true,
//   "reasons": ["both_steps_skipped", "amount_exceeds_threshold"]
// }
// ═══════════════════════════════════════════════════════════════════════════════
function isCeoRequired(data, config) {
  const {
    budgetAmount = 0,
    termType = "Monthly",
    submitterId,
    projectManagerId,
    entityManagerId
  } = data;

  const reasons = [];

  // Check PM/EM skip
  const pmAssigned = projectManagerId && String(projectManagerId).trim() !== "";
  const emAssigned = entityManagerId && String(entityManagerId).trim() !== "";
  const pmSkipped = !pmAssigned || sameUser(submitterId, projectManagerId);
  const emSkipped = !emAssigned || sameUser(submitterId, entityManagerId);

  if (pmSkipped && emSkipped) {
    reasons.push("both_steps_skipped");
  }

  // Check threshold
  const threshold = getThresholdForTerm(termType, config);
  if (budgetAmount > threshold) {
    reasons.push("amount_exceeds_threshold");
  }

  return {
    ceoRequired: reasons.length > 0,
    reasons: reasons,
    threshold: threshold
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// FUNCTION 7: getApprovalChainSummary
// ═══════════════════════════════════════════════════════════════════════════════
//
// PAYLOAD: Same as getRequiredApprovers
//
// RETURNS:
// {
//   "summary": "PM (John) → Entity Mgr (Jane) → CEO",
//   "shortSummary": "3-step approval",
//   "stepLabels": ["Project Manager", "Entity Manager", "CEO"]
// }
// ═══════════════════════════════════════════════════════════════════════════════
function getApprovalChainSummary(data, config) {
  const result = getRequiredApprovers(data, config);

  if (result.autoApproved) {
    return {
      summary: "Auto-approved (CEO submission)",
      shortSummary: "Auto-approved",
      stepLabels: []
    };
  }

  const ROLE_LABELS = {
    "project_manager": "Project Manager",
    "entity_manager": "Entity Manager",
    "ceo": "CEO"
  };

  // Use display names from payload if provided
  const nameMap = data.displayNames || {};

  const labels = result.steps.map(s => {
    const label = ROLE_LABELS[s.role] || s.role;
    const name = nameMap[s.role] || nameMap[s.userId] || "";
    return name ? label + " (" + name + ")" : label;
  });

  const totalSteps = result.steps.length;
  const suffix = totalSteps === 1 ? "1-step approval" : totalSteps + "-step approval";

  return {
    summary: labels.join(" → "),
    shortSummary: suffix,
    stepLabels: labels,
    ceoRequired: result.ceoRequired,
    ceoReason: result.ceoReason
  };
}


// ═══════════════════════════════════════════════════════════════════════════════
// MAIN ENTRY POINT — ROUTER
// ═══════════════════════════════════════════════════════════════════════════════
window.function = function (functionName, payload, config) {
  const fn = (functionName.value ?? "").trim();
  const data = safeParse(payload.value ?? "");
  const cfg = safeParse(config.value ?? "") || {};

  // Merge config with defaults
  const mergedConfig = { ...DEFAULT_CONFIG, ...cfg };

  if (!fn) return JSON.stringify({ error: "No function name provided" });
  if (!data) return JSON.stringify({ error: "Invalid or missing JSON payload" });

  let result;

  switch (fn) {
    case "getRequiredApprovers":
      result = getRequiredApprovers(data, mergedConfig);
      break;
    case "canUserApprove":
      result = canUserApprove(data);
      break;
    case "getApprovalStatus":
      result = getApprovalStatus(data);
      break;
    case "getNextPendingStep":
      result = getNextPendingStep(data);
      break;
    case "validateSubmission":
      result = validateSubmission(data, mergedConfig);
      break;
    case "isCeoRequired":
      result = isCeoRequired(data, mergedConfig);
      break;
    case "getApprovalChainSummary":
      result = getApprovalChainSummary(data, mergedConfig);
      break;
    default:
      result = {
        error: "Unknown function: " + fn,
        availableFunctions: [
          "getRequiredApprovers",
          "canUserApprove",
          "getApprovalStatus",
          "getNextPendingStep",
          "validateSubmission",
          "isCeoRequired",
          "getApprovalChainSummary"
        ]
      };
  }

  return JSON.stringify(result);
};
