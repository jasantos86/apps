// ═══════════════════════════════════════════════════════════════════════════════
// Budget Approval Engine — Experimental Code Column for Glide
// ═══════════════════════════════════════════════════════════════════════════════
//
// A multi-function code column that implements the Budget Authorization Workflow
// from the Treasury App Authorization Map.
//
// USAGE:
//   function_name (string) — which function to call
//   payload       (string) — JSON object with function-specific inputs
//   config        (string) — JSON object with threshold configuration
//
// RETURNS:
//   JSON string with the result (parse downstream in Glide)
//
// ─── FIELD NAMING CONVENTION ─────────────────────────────────────────────────
// All payload fields use snake_case to match Glide column names:
//   owner_id, owner_roles, project_manager_id, entity_manager_id,
//   budget_total, term, approval_status, etc.
//
// ─── ROLES FORMAT ────────────────────────────────────────────────────────────
// owner_roles / approver_roles accepts EITHER:
//   • Comma-separated string:  "tre.auth.ceo, Accountant"
//   • JSON array of strings:   ["tre.auth.ceo", "Accountant"]
//
// ─── AVAILABLE FUNCTIONS (5 consolidated) ─────────────────────────────────────
//   1. getApprovalChain     — Full chain + CEO check + human-readable summary
//   2. canUserApprove       — Can a specific user approve at this step?
//   3. getApprovalProgress  — Workflow state + progress + next pending step
//   4. validateSubmission   — Pre-submit validation with errors/warnings
//   5. getUserPermissions   — Can the active user edit / delete this budget?
//
// Legacy aliases (still supported for backward compatibility):
//   getRequiredApprovers, isCeoRequired, getApprovalChainSummary,
//   getApprovalStatus, getNextPendingStep, canUserEditBudget, canUserDeleteBudget
//
// ═══════════════════════════════════════════════════════════════════════════════


// ─── ROLE CONSTANTS ───────────────────────────────────────────────────────────
var CEO_ROLE = "tre.auth.ceo";

// ─── DEFAULT CONFIGURATION ──────────────────────────────────────────────────
const DEFAULT_CONFIG = {
  MONTHLY_BUDGET_LIMIT: 10000,
  ANNUAL_BUDGET_LIMIT: 50000,
  LUMPSUM_BUDGET_LIMIT: 100000
};

// ─── HELPER: Parse JSON safely ──────────────────────────────────────────────
function safeParse(str) {
  if (!str) return null;
  try { return JSON.parse(str); }
  catch (e) { return null; }
}

// ─── HELPER: Normalize roles input ──────────────────────────────────────────
// Accepts: "tre.auth.ceo, Accountant" OR ["tre.auth.ceo","Accountant"] OR "tre.auth.ceo"
// Returns: ["tre.auth.ceo", "accountant"]  (lowercase, trimmed array)
function parseRoles(input) {
  if (!input) return [];
  if (Array.isArray(input)) {
    return input.map(function(r) { return String(r).trim().toLowerCase(); }).filter(Boolean);
  }
  if (typeof input === "string") {
    // Try JSON parse first (in case it's a stringified array)
    var parsed = safeParse(input);
    if (Array.isArray(parsed)) {
      return parsed.map(function(r) { return String(r).trim().toLowerCase(); }).filter(Boolean);
    }
    // Otherwise treat as comma-separated
    return input.split(",").map(function(r) { return r.trim().toLowerCase(); }).filter(Boolean);
  }
  return [];
}

// ─── HELPER: Get budget threshold for a term type ───────────────────────────
function getThresholdForTerm(term, config) {
  var t = (term || "").toLowerCase().trim();
  if (t === "monthly")  return config.MONTHLY_BUDGET_LIMIT  ?? DEFAULT_CONFIG.MONTHLY_BUDGET_LIMIT;
  if (t === "annual")   return config.ANNUAL_BUDGET_LIMIT   ?? DEFAULT_CONFIG.ANNUAL_BUDGET_LIMIT;
  if (t === "lump sum" || t === "lumpsum" || t === "lump_sum")
    return config.LUMPSUM_BUDGET_LIMIT ?? DEFAULT_CONFIG.LUMPSUM_BUDGET_LIMIT;
  return config.MONTHLY_BUDGET_LIMIT ?? DEFAULT_CONFIG.MONTHLY_BUDGET_LIMIT;
}

// ─── HELPER: Compare user IDs (case-insensitive, trimmed) ───────────────────
function sameUser(a, b) {
  if (!a || !b) return false;
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

// ─── HELPER: Check if a user ID string is present and non-empty ─────────────
function isAssigned(id) {
  return id != null && String(id).trim() !== "";
}


// ═══════════════════════════════════════════════════════════════════════════════
// FUNCTION 1: getRequiredApprovers
// ═══════════════════════════════════════════════════════════════════════════════
//
// PAYLOAD (fields from your budget row):
// {
//   "owner_id":             "SxPxchsmS.2tGPVdRPVHHg",
//   "owner_roles":          "tre.auth.ceo" | ["tre.auth.ceo"] | "tre.auth.ceo, Accountant",
//   "budget_total":         18600,
//   "term":                 "Annual",
//   "project_manager_id":   "IGDTvm71TuSnsezrMYyL5Q",
//   "project_manager_name": "Diego Tobias",         // optional, for summary
//   "entity_manager_id":    "IGDTvm71TuSnsezrMYyL5Q",
//   "entity_manager_name":  "Diego Tobias"          // optional, for summary
// }
//
// RETURNS:
// {
//   "auto_approved": false,
//   "steps": [
//     { "step": 1, "role": "project_manager", "user_id": "...", "user_name": "...", "status": "pending" },
//     { "step": 2, "role": "entity_manager",  "user_id": "...", "user_name": "...", "status": "pending" },
//     { "step": 3, "role": "tre.auth.ceo",     "user_id": null,  "user_name": null,  "status": "pending" }
//   ],
//   "ceo_required": true,
//   "ceo_reason": "amount_exceeds_threshold",
//   "threshold": 50000,
//   "total_steps": 3
// }
// ═══════════════════════════════════════════════════════════════════════════════
function getRequiredApprovers(data, config) {
  var ownerId   = data.owner_id;
  var roles     = parseRoles(data.owner_roles);
  var amount    = Number(data.budget_total) || 0;
  var term      = data.term || "Monthly";
  var pmId      = data.project_manager_id;
  var pmName    = data.project_manager_name || null;
  var emId      = data.entity_manager_id;
  var emName    = data.entity_manager_name || null;

  // ── CEO auto-approves ──
  if (roles.indexOf(CEO_ROLE) !== -1) {
    return {
      auto_approved: true,
      steps: [],
      ceo_required: false,
      ceo_reason: "submitter_is_ceo",
      threshold: null,
      total_steps: 0
    };
  }

  var steps = [];
  var pmSkipped = false;
  var emSkipped = false;
  var ceoRequired = false;
  var ceoReason = null;

  // ── Step 1: Project Manager ──
  if (isAssigned(pmId) && !sameUser(ownerId, pmId)) {
    steps.push({
      step: 1,
      role: "project_manager",
      user_id: pmId,
      user_name: pmName,
      status: "pending"
    });
  } else {
    pmSkipped = true;
  }

  // ── Step 2: Entity Manager ──
  if (isAssigned(emId) && !sameUser(ownerId, emId)) {
    // If PM and EM are the same person and PM was already added, skip EM
    // to avoid requiring the same person to approve twice
    var emAlreadyInChain = steps.some(function(s) { return sameUser(s.user_id, emId); });
    if (!emAlreadyInChain) {
      steps.push({
        step: 2,
        role: "entity_manager",
        user_id: emId,
        user_name: emName,
        status: "pending"
      });
    } else {
      emSkipped = true;
    }
  } else {
    emSkipped = true;
  }

  // ── Both skipped safeguard ──
  if (pmSkipped && emSkipped) {
    ceoRequired = true;
    ceoReason = "both_steps_skipped";
  }

  // ── Threshold check ──
  var threshold = getThresholdForTerm(term, config);
  if (amount > threshold) {
    ceoRequired = true;
    ceoReason = ceoReason
      ? ceoReason + "+amount_exceeds_threshold"
      : "amount_exceeds_threshold";
  }

  // ── Add CEO step if required ──
  if (ceoRequired) {
    steps.push({
      step: 3,
      role: CEO_ROLE,
      user_id: null,
      user_name: null,
      status: "pending"
    });
  }

  // Re-number steps sequentially
  for (var i = 0; i < steps.length; i++) {
    steps[i].step = i + 1;
  }

  return {
    auto_approved: false,
    steps: steps,
    ceo_required: ceoRequired,
    ceo_reason: ceoReason,
    threshold: threshold,
    total_steps: steps.length
  };
}


// ═══════════════════════════════════════════════════════════════════════════════
// FUNCTION 2: canUserApprove
// ═══════════════════════════════════════════════════════════════════════════════
//
// PAYLOAD:
// {
//   "approver_id":          "IGDTvm71TuSnsezrMYyL5Q",
//   "approver_roles":       "tre.auth.ceo" | ["tre.auth.ceo"],
//   "owner_id":             "SxPxchsmS.2tGPVdRPVHHg",
//   "approval_status":      "Review",
//   "approval_steps":       [...],          // stored from getRequiredApprovers
//   "completed_steps":      [1],            // step numbers already done
//   "project_manager_id":   "IGDTvm71TuSnsezrMYyL5Q",
//   "entity_manager_id":    "IGDTvm71TuSnsezrMYyL5Q"
// }
//
// RETURNS:
// {
//   "can_approve": true,
//   "reason": "user_is_next_approver",
//   "step_number": 1,
//   "role": "project_manager"
// }
// ═══════════════════════════════════════════════════════════════════════════════
function canUserApprove(data) {
  var approverId     = data.approver_id;
  var roles          = parseRoles(data.approver_roles);
  var ownerId        = data.owner_id;
  var status         = (data.approval_status || "").toLowerCase().trim();
  var approvalSteps  = data.approval_steps || [];
  var completedSteps = data.completed_steps || [];
  var pmId           = data.project_manager_id;
  var emId           = data.entity_manager_id;
  var isCeo          = roles.indexOf(CEO_ROLE) !== -1;

  // Budget must be in Review status
  if (status !== "review") {
    return { can_approve: false, reason: "budget_not_in_review", step_number: null, role: null };
  }

  // Submitter cannot approve own budget (unless CEO)
  if (sameUser(approverId, ownerId) && !isCeo) {
    return { can_approve: false, reason: "cannot_approve_own_submission", step_number: null, role: null };
  }

  // CEO can always approve (override all remaining steps)
  if (isCeo) {
    var nextForCeo = null;
    for (var i = 0; i < approvalSteps.length; i++) {
      if (completedSteps.indexOf(approvalSteps[i].step) === -1) {
        nextForCeo = approvalSteps[i];
        break;
      }
    }
    return {
      can_approve: true,
      reason: "ceo_override",
      step_number: nextForCeo ? nextForCeo.step : null,
      role: CEO_ROLE
    };
  }

  // Determine which approval roles this user fulfills (can be multiple)
  var approverRolesList = [];
  if (sameUser(approverId, pmId)) approverRolesList.push("project_manager");
  if (sameUser(approverId, emId)) approverRolesList.push("entity_manager");

  if (approverRolesList.length === 0) {
    return { can_approve: false, reason: "user_has_no_approval_role", step_number: null, role: null };
  }

  // Find the next pending step
  var nextPending = null;
  for (var j = 0; j < approvalSteps.length; j++) {
    if (completedSteps.indexOf(approvalSteps[j].step) === -1) {
      nextPending = approvalSteps[j];
      break;
    }
  }

  if (!nextPending) {
    return { can_approve: false, reason: "all_steps_complete", step_number: null, role: approverRolesList[0] };
  }

  // Check if ANY of this user's roles match the next pending step
  if (approverRolesList.indexOf(nextPending.role) !== -1) {
    return {
      can_approve: true,
      reason: "user_is_next_approver",
      step_number: nextPending.step,
      role: nextPending.role
    };
  }

  return {
    can_approve: false,
    reason: "not_your_turn",
    step_number: nextPending.step,
    role: approverRolesList[0],
    waiting_for: nextPending.role
  };
}


// ═══════════════════════════════════════════════════════════════════════════════
// FUNCTION 3: getApprovalStatus
// ═══════════════════════════════════════════════════════════════════════════════
//
// PAYLOAD:
// {
//   "approval_steps":   [...],
//   "completed_steps":  [1, 2],
//   "rejected_step":    null,        // step number if rejected, else null
//   "auto_approved":    false
// }
//
// RETURNS:
// {
//   "overall_status":   "approved",  // "pending"|"approved"|"rejected"|"auto_approved"
//   "progress":         "2/2",
//   "percent_complete":  100,
//   "pending_steps":    [],
//   "completed_steps":  [...],
//   "is_complete":      true
// }
// ═══════════════════════════════════════════════════════════════════════════════
function getApprovalStatus(data) {
  var approvalSteps  = data.approval_steps || [];
  var completedSteps = data.completed_steps || [];
  var rejectedStep   = data.rejected_step;
  var autoApproved   = data.auto_approved || false;

  if (autoApproved) {
    return {
      overall_status: "auto_approved",
      progress: "0/0",
      percent_complete: 100,
      pending_steps: [],
      completed_steps: [],
      is_complete: true
    };
  }

  var total = approvalSteps.length;

  if (rejectedStep != null) {
    var rejStepObj = null;
    for (var i = 0; i < approvalSteps.length; i++) {
      if (approvalSteps[i].step === rejectedStep) { rejStepObj = approvalSteps[i]; break; }
    }
    return {
      overall_status: "rejected",
      progress: completedSteps.length + "/" + total,
      percent_complete: total > 0 ? Math.round((completedSteps.length / total) * 100) : 0,
      pending_steps: [],
      completed_steps: approvalSteps.filter(function(s) { return completedSteps.indexOf(s.step) !== -1; }),
      rejected_at: rejStepObj || { step: rejectedStep },
      is_complete: true
    };
  }

  var pending = approvalSteps.filter(function(s) { return completedSteps.indexOf(s.step) === -1; });
  var completed = approvalSteps.filter(function(s) { return completedSteps.indexOf(s.step) !== -1; });
  var isComplete = pending.length === 0 && total > 0;

  return {
    overall_status: isComplete ? "approved" : "pending",
    progress: completedSteps.length + "/" + total,
    percent_complete: total > 0 ? Math.round((completedSteps.length / total) * 100) : 0,
    pending_steps: pending,
    completed_steps: completed,
    is_complete: isComplete
  };
}


// ═══════════════════════════════════════════════════════════════════════════════
// FUNCTION 4: getNextPendingStep
// ═══════════════════════════════════════════════════════════════════════════════
//
// PAYLOAD:
// {
//   "approval_steps":  [...],
//   "completed_steps": [1]
// }
//
// RETURNS:
// {
//   "has_next": true,
//   "step": 2,
//   "role": "entity_manager",
//   "user_id": "...",
//   "user_name": "Diego Tobias",
//   "display_label": "Entity Manager"
// }
// ═══════════════════════════════════════════════════════════════════════════════
function getNextPendingStep(data) {
  var approvalSteps  = data.approval_steps || [];
  var completedSteps = data.completed_steps || [];

  var ROLE_LABELS = {
    "project_manager": "Project Manager",
    "entity_manager": "Entity Manager"
  };
  ROLE_LABELS[CEO_ROLE] = "CEO";

  var next = null;
  for (var i = 0; i < approvalSteps.length; i++) {
    if (completedSteps.indexOf(approvalSteps[i].step) === -1) {
      next = approvalSteps[i];
      break;
    }
  }

  if (!next) {
    return {
      has_next: false,
      step: null,
      role: null,
      user_id: null,
      user_name: null,
      display_label: "All approvals complete"
    };
  }

  return {
    has_next: true,
    step: next.step,
    role: next.role,
    user_id: next.user_id,
    user_name: next.user_name || null,
    display_label: ROLE_LABELS[next.role] || next.role
  };
}


// ═══════════════════════════════════════════════════════════════════════════════
// FUNCTION 5: validateSubmission
// ═══════════════════════════════════════════════════════════════════════════════
//
// PAYLOAD:
// {
//   "approval_status":  "Draft",
//   "budget_total":     18600,
//   "term":             "Annual",
//   "category_count":   2,            // number of categories (0 = none)
//   "owner_id":         "SxPxchsmS.2tGPVdRPVHHg",
//   "owner_roles":      "tre.auth.ceo"
// }
//
// RETURNS:
// {
//   "can_submit": true,
//   "errors": [],
//   "warnings": ["Budget exceeds Annual threshold ($50,000). CEO approval required."]
// }
// ═══════════════════════════════════════════════════════════════════════════════
function validateSubmission(data, config) {
  var status   = (data.approval_status || "").toLowerCase().trim();
  var amount   = Number(data.budget_total) || 0;
  var term     = data.term || "Monthly";
  var catCount = Number(data.category_count) || 0;
  var roles    = parseRoles(data.owner_roles);

  var errors   = [];
  var warnings = [];

  if (status !== "draft") {
    errors.push("Budget must be in Draft status to submit. Current: " + data.approval_status);
  }
  if (amount <= 0) {
    errors.push("Budget total must be greater than zero.");
  }
  if (catCount < 1) {
    errors.push("Budget must have at least one category.");
  }

  var validTerms = ["monthly", "annual", "lump sum", "lumpsum", "lump_sum"];
  if (validTerms.indexOf(term.toLowerCase().trim()) === -1) {
    errors.push("Invalid budget term: " + term);
  }

  var threshold = getThresholdForTerm(term, config);
  if (amount > threshold) {
    warnings.push(
      "Budget total ($" + amount.toLocaleString() +
      ") exceeds " + term + " threshold ($" + threshold.toLocaleString() +
      "). CEO approval will be required."
    );
  }

  return {
    can_submit: errors.length === 0,
    errors: errors,
    warnings: warnings
  };
}


// ═══════════════════════════════════════════════════════════════════════════════
// CONSOLIDATED FUNCTION 1: getApprovalChain
// ═══════════════════════════════════════════════════════════════════════════════
//
// Merges: getRequiredApprovers + isCeoRequired + getApprovalChainSummary
// Single call returns the full chain, CEO analysis, and display summary.
//
// PAYLOAD:  Budget row JSON (+ owner_roles)
// {
//   "owner_id":             "SxPxchsmS.2tGPVdRPVHHg",
//   "owner_roles":          "tre.auth.ceo" | ["tre.auth.ceo", "Accountant"],
//   "budget_total":         18600,
//   "term":                 "Annual",
//   "project_manager_id":   "IGDTvm71TuSnsezrMYyL5Q",
//   "project_manager_name": "Diego Tobias",
//   "entity_manager_id":    "IGDTvm71TuSnsezrMYyL5Q",
//   "entity_manager_name":  "Diego Tobias"
// }
//
// RETURNS:
// {
//   "auto_approved": false,
//   "steps": [ ... ],
//   "total_steps": 3,
//   "ceo_required": true,
//   "ceo_reason": "amount_exceeds_threshold",
//   "ceo_reasons": ["amount_exceeds_threshold"],
//   "threshold": 50000,
//   "summary": "Project Manager (Diego Tobias) → Entity Manager (Bob) → CEO",
//   "short_summary": "3-step approval",
//   "step_labels": ["Project Manager (Diego Tobias)", "Entity Manager (Bob)", "CEO"]
// }
// ═══════════════════════════════════════════════════════════════════════════════
function getApprovalChain(data, config) {
  var chain = getRequiredApprovers(data, config);

  // ── CEO reasons (expanded array form) ──
  var ceoReasons = [];
  if (chain.ceo_reason) {
    ceoReasons = chain.ceo_reason.split("+");
  }

  // ── Summary labels ──
  var ROLE_LABELS = {
    "project_manager": "Project Manager",
    "entity_manager": "Entity Manager"
  };
  ROLE_LABELS[CEO_ROLE] = "CEO";

  var summary, shortSummary, stepLabels;

  if (chain.auto_approved) {
    summary = "Auto-approved (CEO submission)";
    shortSummary = "Auto-approved";
    stepLabels = [];
  } else {
    stepLabels = chain.steps.map(function(s) {
      var label = ROLE_LABELS[s.role] || s.role;
      var name = s.user_name || "";
      return name ? label + " (" + name + ")" : label;
    });
    summary = stepLabels.join(" → ");
    var n = chain.steps.length;
    shortSummary = n === 1 ? "1-step approval" : n + "-step approval";
  }

  return {
    auto_approved: chain.auto_approved,
    steps: chain.steps,
    total_steps: chain.total_steps,
    ceo_required: chain.ceo_required,
    ceo_reason: chain.ceo_reason,
    ceo_reasons: ceoReasons,
    threshold: chain.threshold,
    summary: summary,
    short_summary: shortSummary,
    step_labels: stepLabels
  };
}


// ═══════════════════════════════════════════════════════════════════════════════
// CONSOLIDATED FUNCTION 3: getApprovalProgress
// ═══════════════════════════════════════════════════════════════════════════════
//
// Merges: getApprovalStatus + getNextPendingStep
// Single call returns workflow state, progress, and who needs to act next.
//
// PAYLOAD:
// {
//   "approval_steps":   [...],
//   "completed_steps":  [1, 2],
//   "rejected_step":    null,
//   "auto_approved":    false
// }
//
// RETURNS:
// {
//   "overall_status":   "pending",
//   "progress":         "1/2",
//   "percent_complete":  50,
//   "is_complete":      false,
//   "pending_steps":    [...],
//   "completed_steps":  [...],
//   "rejected_at":      null,
//   "next_step":        2,
//   "next_role":        "entity_manager",
//   "next_user_id":     "...",
//   "next_user_name":   "Diego Tobias",
//   "next_display_label": "Entity Manager"
// }
// ═══════════════════════════════════════════════════════════════════════════════
function getApprovalProgress(data) {
  var statusResult = getApprovalStatus(data);
  var nextResult   = getNextPendingStep(data);

  return {
    // ── Status fields ──
    overall_status: statusResult.overall_status,
    progress: statusResult.progress,
    percent_complete: statusResult.percent_complete,
    is_complete: statusResult.is_complete,
    pending_steps: statusResult.pending_steps || [],
    completed_steps: statusResult.completed_steps || [],
    rejected_at: statusResult.rejected_at || null,
    // ── Next step fields ──
    has_next: nextResult.has_next,
    next_step: nextResult.step,
    next_role: nextResult.role,
    next_user_id: nextResult.user_id,
    next_user_name: nextResult.user_name,
    next_display_label: nextResult.display_label
  };
}


// ═══════════════════════════════════════════════════════════════════════════════
// CONSOLIDATED FUNCTION 5: getUserPermissions
// ═══════════════════════════════════════════════════════════════════════════════
//
// Merges: canUserEditBudget + canUserDeleteBudget
// Single call returns both edit and delete permissions for the active user.
//
// PAYLOAD:  Budget row JSON + active user fields
// {
//   "user_id":    "«Signed-In User RowID»",
//   "user_roles": "«Signed-In User Roles»",
//   ... all budget row fields (owner_id, responsible_id, approval_status, etc.) ...
// }
//
// RETURNS:
// {
//   "can_edit":       true,
//   "edit_reason":    "user_is_owner",
//   "can_delete":     true,
//   "delete_reason":  "user_is_owner"
// }
// ═══════════════════════════════════════════════════════════════════════════════
function getUserPermissions(data) {
  var userId = data.user_id;
  var roles  = parseRoles(data.user_roles);
  var status = (data.approval_status || "").toLowerCase().trim();
  var isCeo  = roles.indexOf(CEO_ROLE) !== -1;

  // ── Default: no permissions ──
  var canEdit = false;
  var editReason = "no_permission";
  var canDelete = false;
  var deleteReason = "no_permission";

  if (!userId) {
    return {
      can_edit: false,  edit_reason: "no_user_id",
      can_delete: false, delete_reason: "no_user_id"
    };
  }

  // ── Edit permissions (Draft only) ──
  if (status === "draft") {
    if (isCeo) {
      canEdit = true; editReason = "user_is_ceo";
    } else if (sameUser(userId, data.owner_id)) {
      canEdit = true; editReason = "user_is_owner";
    } else if (sameUser(userId, data.responsible_id)) {
      canEdit = true; editReason = "user_is_responsible";
    } else if (sameUser(userId, data.project_manager_id)) {
      canEdit = true; editReason = "user_is_project_manager";
    } else if (sameUser(userId, data.entity_manager_id)) {
      canEdit = true; editReason = "user_is_entity_manager";
    }
  } else {
    editReason = "budget_not_in_draft";
  }

  // ── Delete permissions (Owner + CEO, any status) ──
  if (isCeo) {
    canDelete = true; deleteReason = "user_is_ceo";
  } else if (sameUser(userId, data.owner_id)) {
    canDelete = true; deleteReason = "user_is_owner";
  }

  return {
    can_edit: canEdit,
    edit_reason: editReason,
    can_delete: canDelete,
    delete_reason: deleteReason
  };
}


// ═══════════════════════════════════════════════════════════════════════════════
// MAIN ENTRY POINT — ROUTER
// ═══════════════════════════════════════════════════════════════════════════════
window.function = function (functionName, payload, config) {
  var fn   = (functionName.value ?? "").trim();
  var data = safeParse(payload.value ?? "");
  var cfg  = safeParse(config.value ?? "") || {};

  var mergedConfig = {};
  for (var k in DEFAULT_CONFIG) { mergedConfig[k] = DEFAULT_CONFIG[k]; }
  for (var k2 in cfg) { mergedConfig[k2] = cfg[k2]; }

  if (!fn) return JSON.stringify({ error: "No function name provided" });
  if (!data) return JSON.stringify({ error: "Invalid or missing JSON payload" });

  var result;

  switch (fn) {
    // ── Consolidated functions (use these) ──
    case "getApprovalChain":
      result = getApprovalChain(data, mergedConfig);
      break;
    case "canUserApprove":
      result = canUserApprove(data);
      break;
    case "getApprovalProgress":
      result = getApprovalProgress(data);
      break;
    case "validateSubmission":
      result = validateSubmission(data, mergedConfig);
      break;
    case "getUserPermissions":
      result = getUserPermissions(data);
      break;

    // ── Legacy aliases (backward compatibility) ──
    case "getRequiredApprovers":
      result = getRequiredApprovers(data, mergedConfig);
      break;
    case "isCeoRequired":
      result = getApprovalChain(data, mergedConfig);  // superset
      break;
    case "getApprovalChainSummary":
      result = getApprovalChain(data, mergedConfig);  // superset
      break;
    case "getApprovalStatus":
      result = getApprovalStatus(data);
      break;
    case "getNextPendingStep":
      result = getNextPendingStep(data);
      break;
    case "canUserEditBudget":
      result = getUserPermissions(data);  // superset
      break;
    case "canUserDeleteBudget":
      result = getUserPermissions(data);  // superset
      break;

    default:
      result = {
        error: "Unknown function: " + fn,
        available_functions: [
          "getApprovalChain",
          "canUserApprove",
          "getApprovalProgress",
          "validateSubmission",
          "getUserPermissions"
        ]
      };
  }

  return JSON.stringify(result);
};
