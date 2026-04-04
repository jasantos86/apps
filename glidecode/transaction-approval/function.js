// ═══════════════════════════════════════════════════════════════════════════════
// Transaction Approval Engine — Experimental Code Column for Glide
// ═══════════════════════════════════════════════════════════════════════════════
//
// A multi-function code column that implements the Transaction Authorization
// Workflow from the Treasury App Authorization Map.
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
//   transaction_amount, transaction_type, approval_status, etc.
//
// ─── ROLES FORMAT ────────────────────────────────────────────────────────────
// owner_roles / approver_roles accepts EITHER:
//   • Comma-separated string:  "tre.auth.ceo, Accountant"
//   • JSON array of strings:   ["tre.auth.ceo", "Accountant"]
//
// ─── TRANSACTION TYPES ───────────────────────────────────────────────────────
// • "expense"   — Requires approval chain (PM → EM → CEO)
// • "revenue"   — Auto-approved on submission (no approval needed)
// • "income"    — Auto-approved on submission (alias for revenue)
//
// ─── AVAILABLE FUNCTIONS (4 consolidated) ────────────────────────────────────
//   1. getApprovalChain     — Full chain + CEO reasons + budget impact + summary
//   2. getApprovalProgress  — Status + progress + next step + can-approve gate
//   3. validateSubmission   — Pre-submit validation with errors/warnings
//   4. getUserPermissions   — Edit/delete/cancel permissions + invoice review
//
// Legacy aliases (still supported for backward compatibility):
//   canUserApprove, getInvoiceReview
//
// ═══════════════════════════════════════════════════════════════════════════════


// ─── ROLE CONSTANTS ───────────────────────────────────────────────────────────
var CEO_ROLE = "tre.auth.ceo";

// ─── DEFAULT CONFIGURATION ──────────────────────────────────────────────────
var DEFAULT_CONFIG = {};
// Transaction approval uses per-manager limits passed in the payload,
// not global thresholds. Config is reserved for future use.


// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

// ─── HELPER: Parse JSON safely ──────────────────────────────────────────────
function safeParse(str) {
  if (!str) return null;
  try { return JSON.parse(str); }
  catch (e) { return null; }
}

// ─── HELPER: Ensure value is an array (parse if string) ─────────────────────
function ensureArray(val) {
  if (Array.isArray(val)) return val;
  if (typeof val === "string" && val.trim()) {
    try { var parsed = JSON.parse(val); if (Array.isArray(parsed)) return parsed; }
    catch (e) { /* not valid JSON */ }
  }
  return [];
}

// ─── HELPER: Normalize roles input ──────────────────────────────────────────
// Accepts: "tre.auth.ceo, Accountant" OR ["tre.auth.ceo","Accountant"]
// Returns: ["tre.auth.ceo", "accountant"]  (lowercase, trimmed array)
function parseRoles(input) {
  if (!input) return [];
  if (Array.isArray(input)) {
    return input.map(function(r) { return String(r).trim().toLowerCase(); }).filter(Boolean);
  }
  if (typeof input === "string") {
    var parsed = safeParse(input);
    if (Array.isArray(parsed)) {
      return parsed.map(function(r) { return String(r).trim().toLowerCase(); }).filter(Boolean);
    }
    return input.split(",").map(function(r) { return r.trim().toLowerCase(); }).filter(Boolean);
  }
  return [];
}

// ─── HELPER: Compare user IDs (case-insensitive, trimmed) ───────────────────
function sameUser(a, b) {
  if (!a || !b) return false;
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

// ─── HELPER: Safe number coercion ───────────────────────────────────────────
function toNum(val) {
  var n = Number(val);
  return isNaN(n) ? 0 : n;
}

// ─── HELPER: Normalize transaction type ─────────────────────────────────────
function normalizeType(type) {
  var t = (type || "").toLowerCase().trim();
  if (t === "revenue" || t === "income") return "revenue";
  return "expense";
}

// ─── HELPER: Check if transaction type is auto-approved ─────────────────────
function isAutoApprovedType(type) {
  return normalizeType(type) === "revenue";
}


// ═══════════════════════════════════════════════════════════════════════════════
// INTERNAL FUNCTION: getRequiredApprovers
// ═══════════════════════════════════════════════════════════════════════════════
//
// Determines the sequential approval chain for an expense transaction.
//
// PAYLOAD:
// {
//   "owner_id":               "SxPxchsmS.2tGPVdRPVHHg",
//   "owner_roles":            "tre.auth.ceo" | ["tre.auth.ceo", "Accountant"],
//   "transaction_type":       "expense",
//   "transaction_amount":     15000,
//   "project_manager_id":     "IGDTvm71TuSnsezrMYyL5Q",
//   "project_manager_name":   "Diego Tobias",
//   "entity_manager_id":      "IGDTvm71TuSnsezrMYyL5Q",
//   "entity_manager_name":    "Diego Tobias",
//   "pm_monthly_limit":       50000,       // null/undefined = unlimited
//   "pm_accumulated_limit":   500000,      // null/undefined = unlimited
//   "pm_monthly_used":        12000,       // how much PM has approved this month
//   "pm_accumulated_used":    120000,      // PM lifetime approved total
//   "em_monthly_limit":       100000,      // null/undefined = unlimited
//   "em_accumulated_limit":   1000000,     // null/undefined = unlimited
//   "em_monthly_used":        45000,       // how much EM has approved this month
//   "em_accumulated_used":    300000,      // EM lifetime approved total
//   "budget_allocated":       100000,      // total budget allocated amount
//   "budget_reserved":        20000,       // currently reserved by pending txns
//   "budget_spent":           30000        // already spent/paid
// }
//
// RETURNS:
// {
//   "auto_approved": false,
//   "auto_approve_reason": null,
//   "steps": [ { step: 1, role: "project_manager", ... }, ... ],
//   "total_steps": 2,
//   "ceo_required": false,
//   "ceo_reasons": [],
//   "pm_skipped": false,
//   "pm_skip_reason": null,
//   "em_skipped": false,
//   "em_skip_reason": null,
//   "would_exceed_budget": false,
//   "budget_after_transaction": { allocated: 100000, reserved: 35000, spent: 30000, available: 35000 }
// }
// ═══════════════════════════════════════════════════════════════════════════════
function getRequiredApprovers(data, config) {
  var ownerId     = data.owner_id;
  var ownerRoles  = parseRoles(data.owner_roles);
  var txnType     = normalizeType(data.transaction_type);
  var amount      = toNum(data.transaction_amount);

  var pmId        = data.project_manager_id;
  var pmName      = data.project_manager_name || "";
  var emId        = data.entity_manager_id;
  var emName      = data.entity_manager_name || "";

  // ── Revenue/Income → auto-approved ──
  if (txnType === "revenue") {
    return {
      auto_approved: true,
      auto_approve_reason: "revenue_transaction",
      steps: [],
      total_steps: 0,
      ceo_required: false,
      ceo_reasons: [],
      pm_skipped: true,
      pm_skip_reason: "revenue_auto_approved",
      em_skipped: true,
      em_skip_reason: "revenue_auto_approved",
      would_exceed_budget: false,
      budget_after_transaction: null
    };
  }

  // ── CEO submitter → auto-approved ──
  var isCeo = ownerRoles.indexOf(CEO_ROLE) !== -1;
  if (isCeo) {
    return {
      auto_approved: true,
      auto_approve_reason: "submitter_is_ceo",
      steps: [],
      total_steps: 0,
      ceo_required: false,
      ceo_reasons: [],
      pm_skipped: true,
      pm_skip_reason: "ceo_auto_approved",
      em_skipped: true,
      em_skip_reason: "ceo_auto_approved",
      would_exceed_budget: false,
      budget_after_transaction: null
    };
  }

  // ── Compute budget impact ──
  var budgetAllocated = toNum(data.budget_allocated);
  var budgetReserved  = toNum(data.budget_reserved);
  var budgetSpent     = toNum(data.budget_spent);
  var budgetAvailable = budgetAllocated - budgetReserved - budgetSpent;
  var wouldExceedBudget = (budgetAllocated > 0) && (amount > budgetAvailable);
  var budgetAfter = {
    allocated: budgetAllocated,
    reserved: budgetReserved + amount,
    spent: budgetSpent,
    available: budgetAvailable - amount
  };

  var ceoReasons = [];
  var steps = [];
  var pmSkipped = false;
  var pmSkipReason = null;
  var emSkipped = false;
  var emSkipReason = null;

  // ── Step 1: Project Manager ──
  if (!pmId) {
    pmSkipped = true;
    pmSkipReason = "no_pm_assigned";
  } else if (sameUser(ownerId, pmId)) {
    pmSkipped = true;
    pmSkipReason = "submitter_is_pm";
  } else {
    // Check PM limits
    var pmWithinLimits = checkManagerLimits(
      amount,
      data.pm_monthly_limit, data.pm_monthly_used,
      data.pm_accumulated_limit, data.pm_accumulated_used
    );
    if (pmWithinLimits.within_limits) {
      steps.push({
        step: steps.length + 1,
        role: "project_manager",
        user_id: pmId,
        user_name: pmName,
        status: "pending"
      });
    } else {
      pmSkipped = true;
      pmSkipReason = "pm_limit_exceeded:" + pmWithinLimits.exceeded_limit;
      ceoReasons.push("pm_limit_exceeded");
    }
  }

  // ── Step 2: Entity Manager ──
  if (!emId) {
    emSkipped = true;
    emSkipReason = "no_em_assigned";
  } else if (sameUser(ownerId, emId)) {
    emSkipped = true;
    emSkipReason = "submitter_is_em";
  } else if (pmId && emId && sameUser(pmId, emId) && !pmSkipped) {
    // PM and EM are the same person, PM already in chain → skip EM to avoid duplicate
    emSkipped = true;
    emSkipReason = "same_as_pm";
  } else {
    // Check EM limits
    var emWithinLimits = checkManagerLimits(
      amount,
      data.em_monthly_limit, data.em_monthly_used,
      data.em_accumulated_limit, data.em_accumulated_used
    );
    if (emWithinLimits.within_limits) {
      steps.push({
        step: steps.length + 1,
        role: "entity_manager",
        user_id: emId,
        user_name: emName,
        status: "pending"
      });
    } else {
      emSkipped = true;
      emSkipReason = "em_limit_exceeded:" + emWithinLimits.exceeded_limit;
      ceoReasons.push("em_limit_exceeded");
    }
  }

  // ── Both skipped → CEO required (prevent unilateral authorization) ──
  if (pmSkipped && emSkipped &&
      pmSkipReason !== "revenue_auto_approved" &&
      pmSkipReason !== "ceo_auto_approved") {
    if (ceoReasons.indexOf("both_managers_skipped") === -1) {
      ceoReasons.push("both_managers_skipped");
    }
  }

  // ── Budget overrun → CEO required ──
  if (wouldExceedBudget) {
    ceoReasons.push("would_exceed_budget");
  }

  // ── Add CEO step if any reason triggered ──
  var ceoRequired = ceoReasons.length > 0;
  if (ceoRequired) {
    steps.push({
      step: steps.length + 1,
      role: CEO_ROLE,
      user_id: null,
      user_name: "CEO",
      status: "pending"
    });
  }

  return {
    auto_approved: false,
    auto_approve_reason: null,
    steps: steps,
    total_steps: steps.length,
    ceo_required: ceoRequired,
    ceo_reasons: ceoReasons,
    pm_skipped: pmSkipped,
    pm_skip_reason: pmSkipReason,
    em_skipped: emSkipped,
    em_skip_reason: emSkipReason,
    would_exceed_budget: wouldExceedBudget,
    budget_after_transaction: budgetAfter
  };
}


// ═══════════════════════════════════════════════════════════════════════════════
// HELPER: Check manager approval limits
// ═══════════════════════════════════════════════════════════════════════════════
//
// Returns { within_limits: true/false, exceeded_limit: null | "monthly" | "accumulated" | "both" }
//
// null/undefined limit = unlimited (no restriction).
function checkManagerLimits(amount, monthlyLimit, monthlyUsed, accumulatedLimit, accumulatedUsed) {
  var amt = toNum(amount);
  var monthlyOk = true;
  var accOk = true;

  // Monthly check: if limit is defined and non-null
  if (monthlyLimit != null && monthlyLimit !== "" && monthlyLimit !== false) {
    var mLimit = toNum(monthlyLimit);
    var mUsed  = toNum(monthlyUsed);
    if (mLimit > 0 && (mUsed + amt) > mLimit) {
      monthlyOk = false;
    }
  }

  // Accumulated check: if limit is defined and non-null
  if (accumulatedLimit != null && accumulatedLimit !== "" && accumulatedLimit !== false) {
    var aLimit = toNum(accumulatedLimit);
    var aUsed  = toNum(accumulatedUsed);
    if (aLimit > 0 && (aUsed + amt) > aLimit) {
      accOk = false;
    }
  }

  if (monthlyOk && accOk) {
    return { within_limits: true, exceeded_limit: null };
  }
  var exceeded = (!monthlyOk && !accOk) ? "both" : (!monthlyOk ? "monthly" : "accumulated");
  return { within_limits: false, exceeded_limit: exceeded };
}


// ═══════════════════════════════════════════════════════════════════════════════
// INTERNAL FUNCTION: getApprovalStatus
// ═══════════════════════════════════════════════════════════════════════════════
function getApprovalStatus(data) {
  var approvalSteps  = ensureArray(data.approval_steps);
  var completedSteps = ensureArray(data.completed_steps);
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

  if (rejectedStep != null && rejectedStep !== "" && rejectedStep !== false) {
    var rejNum = toNum(rejectedStep);
    var rejStepObj = null;
    for (var i = 0; i < approvalSteps.length; i++) {
      if (approvalSteps[i].step === rejNum) { rejStepObj = approvalSteps[i]; break; }
    }
    return {
      overall_status: "rejected",
      progress: completedSteps.length + "/" + total,
      percent_complete: total > 0 ? Math.round((completedSteps.length / total) * 100) : 0,
      pending_steps: [],
      completed_steps: approvalSteps.filter(function(s) { return completedSteps.indexOf(s.step) !== -1; }),
      rejected_at: rejStepObj || { step: rejNum },
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
// INTERNAL FUNCTION: getNextPendingStep
// ═══════════════════════════════════════════════════════════════════════════════
function getNextPendingStep(data) {
  var approvalSteps  = ensureArray(data.approval_steps);
  var completedSteps = ensureArray(data.completed_steps);

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
// INTERNAL FUNCTION: canUserApproveInternal
// ═══════════════════════════════════════════════════════════════════════════════
function canUserApproveInternal(data) {
  var approverId     = data.approver_id;
  var roles          = parseRoles(data.approver_roles);
  var ownerId        = data.owner_id;
  var status         = (data.approval_status || "").toLowerCase().trim();
  var approvalSteps  = ensureArray(data.approval_steps);
  var completedSteps = ensureArray(data.completed_steps);
  var pmId           = data.project_manager_id;
  var emId           = data.entity_manager_id;
  var isCeo          = roles.indexOf(CEO_ROLE) !== -1;

  // Transaction must be in a submitted/review status
  var reviewStatuses = ["review", "submitted", "submitted for review", "submitted - approval",
                        "submitted - supervisor review", "pending_approval", "pending approval"];
  if (reviewStatuses.indexOf(status) === -1) {
    return { can_approve: false, reason: "transaction_not_in_review", step_number: null, role: null };
  }

  // Submitter cannot approve own transaction (unless CEO)
  if (sameUser(approverId, ownerId) && !isCeo) {
    return { can_approve: false, reason: "cannot_approve_own_submission", step_number: null, role: null };
  }

  // Determine which approval roles this user fulfills by their assignment
  var approverRolesList = [];
  if (sameUser(approverId, pmId)) approverRolesList.push("project_manager");
  if (sameUser(approverId, emId)) approverRolesList.push("entity_manager");

  // Check contextual role first — if user is PM/EM for this transaction,
  // approve as that role even if they are also CEO
  for (var j = 0; j < approvalSteps.length; j++) {
    var step = approvalSteps[j];
    if (completedSteps.indexOf(step.step) !== -1) continue; // already completed
    if (approverRolesList.indexOf(step.role) !== -1) {
      return {
        can_approve: true,
        reason: "user_is_next_approver",
        step_number: step.step,
        role: step.role
      };
    }
    // If the next pending step is not for this user's contextual role, stop —
    // unless they are CEO (handled below as override)
    break;
  }

  // CEO override — only reached if user has no contextual role match for the next step
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

  if (approverRolesList.length === 0) {
    return { can_approve: false, reason: "user_has_no_approval_role", step_number: null, role: null };
  }

  return { can_approve: false, reason: "not_current_approver", step_number: null, role: null };
}


// ═══════════════════════════════════════════════════════════════════════════════
// CONSOLIDATED FUNCTION 1: getApprovalChain
// ═══════════════════════════════════════════════════════════════════════════════
//
// Merges: getRequiredApprovers + summary generation
// Single call returns the full chain, CEO analysis, budget impact, and
// display summary.
//
// PAYLOAD: Transaction row JSON (+ owner_roles, manager limits, budget figures)
//
// RETURNS: All fields from getRequiredApprovers PLUS:
//   summary, short_summary, step_labels
// ═══════════════════════════════════════════════════════════════════════════════
function getApprovalChain(data, config) {
  var chain = getRequiredApprovers(data, config);

  var ROLE_LABELS = {
    "project_manager": "Project Manager",
    "entity_manager": "Entity Manager"
  };
  ROLE_LABELS[CEO_ROLE] = "CEO";

  var summary, shortSummary, stepLabels;

  if (chain.auto_approved) {
    var reasonLabel = chain.auto_approve_reason === "revenue_transaction"
      ? "Auto-approved (Revenue)"
      : chain.auto_approve_reason === "submitter_is_ceo"
        ? "Auto-approved (CEO submission)"
        : "Auto-approved";
    summary = reasonLabel;
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
    shortSummary = n === 0 ? "No approvals needed" :
                   n === 1 ? "1-step approval" : n + "-step approval";
  }

  // Merge everything
  chain.summary = summary;
  chain.short_summary = shortSummary;
  chain.step_labels = stepLabels;
  return chain;
}


// ═══════════════════════════════════════════════════════════════════════════════
// CONSOLIDATED FUNCTION 2: getApprovalProgress
// ═══════════════════════════════════════════════════════════════════════════════
//
// Merges: getApprovalStatus + getNextPendingStep + canUserApprove
// Single call returns workflow state, progress, next step, AND whether the
// signed-in user can approve at this step.
//
// PAYLOAD:
// {
//   "approval_steps":      [...],
//   "completed_steps":     [1],
//   "rejected_step":       null,
//   "auto_approved":       false,
//   "approver_id":         "«Signed-In User RowID»",
//   "approver_roles":      "tre.auth.ceo" | ["tre.auth.ceo", "Accountant"],
//   "owner_id":            "SxPxchsmS.2tGPVdRPVHHg",
//   "approval_status":     "Review",
//   "project_manager_id":  "IGDTvm71TuSnsezrMYyL5Q",
//   "entity_manager_id":   "IGDTvm71TuSnsezrMYyL5Q"
// }
//
// RETURNS: Combined status + next step + can-approve gate
// ═══════════════════════════════════════════════════════════════════════════════
function getApprovalProgress(data) {
  var statusResult  = getApprovalStatus(data);
  var nextResult    = getNextPendingStep(data);
  var approveResult = canUserApproveInternal(data);

  return {
    // ── Progress fields ──
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
    next_display_label: nextResult.display_label,
    // ── Can-approve fields ──
    can_approve: approveResult.can_approve,
    approve_reason: approveResult.reason,
    approve_step_number: approveResult.step_number,
    approve_role: approveResult.role
  };
}


// ═══════════════════════════════════════════════════════════════════════════════
// CONSOLIDATED FUNCTION 4: validateSubmission
// ═══════════════════════════════════════════════════════════════════════════════
//
// PAYLOAD:
// {
//   "approval_status":      "Draft",
//   "transaction_type":     "expense",
//   "transaction_amount":   15000,
//   "budget_id":            "abc123",        // must have a budget assigned
//   "budget_status":        "Active",        // budget must be Active
//   "budget_allocated":     100000,
//   "budget_reserved":      20000,
//   "budget_spent":         30000,
//   "vendor_id":            "vendor-1",      // must have a payee/vendor
//   "owner_id":             "user-1",
//   "owner_roles":          "Accountant",
//   "description":          "Monthly supplies"
// }
//
// RETURNS:
// {
//   "can_submit": true,
//   "errors": [],
//   "warnings": ["Transaction would exceed budget. CEO approval will be required."],
//   "budget_available": 50000,
//   "budget_remaining_after": 35000
// }
// ═══════════════════════════════════════════════════════════════════════════════
function validateSubmission(data, config) {
  var status       = (data.approval_status || "").toLowerCase().trim();
  var txnType      = normalizeType(data.transaction_type);
  var amount       = toNum(data.transaction_amount);
  var budgetId     = data.budget_id;
  var budgetStatus = (data.budget_status || "").toLowerCase().trim();
  var vendorId     = data.vendor_id;
  var description  = (data.description || "").trim();

  var errors   = [];
  var warnings = [];

  // Status check — must be Draft or Provision
  var validStatuses = ["draft", "provision"];
  if (validStatuses.indexOf(status) === -1) {
    errors.push("Transaction must be in Draft or Provision status to submit. Current: " + (data.approval_status || "none"));
  }

  // Amount check
  if (amount <= 0) {
    errors.push("Transaction amount must be greater than zero.");
  }

  // Vendor/Payee check
  if (!vendorId) {
    errors.push("A vendor or payee must be assigned to the transaction.");
  }

  // Description check
  if (!description) {
    warnings.push("No description provided. Consider adding one for the approval chain.");
  }

  // Revenue transactions — no further checks needed
  if (txnType === "revenue") {
    return {
      can_submit: errors.length === 0,
      errors: errors,
      warnings: warnings,
      budget_available: null,
      budget_remaining_after: null
    };
  }

  // Budget check for expense transactions
  if (!budgetId) {
    errors.push("Expense transactions must be assigned to a budget.");
  } else {
    // Budget must be Active
    if (budgetStatus !== "active") {
      errors.push("Budget must be Active to submit transactions against it. Current budget status: " + (data.budget_status || "none"));
    }

    // Budget availability
    var budgetAllocated = toNum(data.budget_allocated);
    var budgetReserved  = toNum(data.budget_reserved);
    var budgetSpent     = toNum(data.budget_spent);
    var budgetAvailable = budgetAllocated - budgetReserved - budgetSpent;
    var remainingAfter  = budgetAvailable - amount;

    if (amount > budgetAvailable) {
      warnings.push(
        "Transaction ($" + amount.toLocaleString() +
        ") would exceed available budget ($" + budgetAvailable.toLocaleString() +
        "). CEO approval will be required."
      );
    }

    return {
      can_submit: errors.length === 0,
      errors: errors,
      warnings: warnings,
      budget_available: budgetAvailable,
      budget_remaining_after: remainingAfter
    };
  }

  return {
    can_submit: errors.length === 0,
    errors: errors,
    warnings: warnings,
    budget_available: null,
    budget_remaining_after: null
  };
}


// ═══════════════════════════════════════════════════════════════════════════════
// CONSOLIDATED FUNCTION 4: getUserPermissions
// ═══════════════════════════════════════════════════════════════════════════════
//
// Merges: canUserEdit + canUserDelete + canUserCancel + getInvoiceReview
// Single call returns all permission flags AND invoice review status.
//
// PAYLOAD: Transaction row JSON + user fields + responsible person fields
// {
//   "user_id":              "«Signed-In User RowID»",
//   "user_roles":           "«Signed-In User Roles»",
//   "approval_status":      "Draft",
//   "owner_id":             "SxPxchsmS.2tGPVdRPVHHg",
//   "project_manager_id":   "IGDTvm71TuSnsezrMYyL5Q",
//   "entity_manager_id":    "IGDTvm71TuSnsezrMYyL5Q",
//   "responsible_id":       "Ilx390jIT069vRiTZBLYpw",
//   "responsible_name":     "Chris Deluna",
//   "invoice_reviewed":     false
// }
//
// RETURNS:
// {
//   "can_edit": true,   "edit_reason":   "user_is_owner",
//   "can_delete": false, "delete_reason": "transaction_not_in_draft",
//   "can_cancel": true,  "cancel_reason": "user_is_owner",
//   "review_required": true, "can_review": false, "review_reason": "user_is_not_responsible",
//   "reviewer_name": "Chris Deluna", "already_reviewed": false
// }
// ═══════════════════════════════════════════════════════════════════════════════
function getUserPermissions(data) {
  var userId = data.user_id;
  var roles  = parseRoles(data.user_roles);
  var status = (data.approval_status || "").toLowerCase().trim();
  var isCeo  = roles.indexOf(CEO_ROLE) !== -1;

  var canEdit = false;    var editReason = "no_permission";
  var canDelete = false;  var deleteReason = "no_permission";
  var canCancel = false;  var cancelReason = "no_permission";

  if (!userId) {
    return {
      can_edit: false, edit_reason: "no_user_id",
      can_delete: false, delete_reason: "no_user_id",
      can_cancel: false, cancel_reason: "no_user_id",
      review_required: false, can_review: false, review_reason: "no_user_id",
      reviewer_name: null, already_reviewed: false
    };
  }

  // ── Edit: Draft/Provision only. CEO, Owner, PM, EM can edit ──
  var editableStatuses = ["draft", "provision"];
  if (editableStatuses.indexOf(status) !== -1) {
    if (isCeo) {
      canEdit = true; editReason = "user_is_ceo";
    } else if (sameUser(userId, data.owner_id)) {
      canEdit = true; editReason = "user_is_owner";
    } else if (sameUser(userId, data.project_manager_id)) {
      canEdit = true; editReason = "user_is_project_manager";
    } else if (sameUser(userId, data.entity_manager_id)) {
      canEdit = true; editReason = "user_is_entity_manager";
    }
  } else {
    editReason = "transaction_not_editable";
  }

  // ── Delete: Draft only. CEO and Owner can delete ──
  if (status === "draft") {
    if (isCeo) {
      canDelete = true; deleteReason = "user_is_ceo";
    } else if (sameUser(userId, data.owner_id)) {
      canDelete = true; deleteReason = "user_is_owner";
    }
  } else {
    deleteReason = "transaction_not_in_draft";
  }

  // ── Cancel: Draft, Provision, or Review/Submitted. ──
  var terminalStatuses = ["paid", "voided", "cancelled"];
  if (terminalStatuses.indexOf(status) !== -1) {
    cancelReason = "transaction_is_" + status;
  } else {
    if (isCeo) {
      canCancel = true; cancelReason = "user_is_ceo";
    } else if (sameUser(userId, data.owner_id)) {
      canCancel = true; cancelReason = "user_is_owner";
    } else if (sameUser(userId, data.project_manager_id)) {
      canCancel = true; cancelReason = "user_is_project_manager";
    } else if (sameUser(userId, data.entity_manager_id)) {
      canCancel = true; cancelReason = "user_is_entity_manager";
    }
  }

  // ── Invoice Review (merged from getInvoiceReview) ──
  var reviewResult = getInvoiceReviewInternal(data, userId, roles, isCeo, status);

  return {
    can_edit: canEdit, edit_reason: editReason,
    can_delete: canDelete, delete_reason: deleteReason,
    can_cancel: canCancel, cancel_reason: cancelReason,
    review_required: reviewResult.review_required,
    can_review: reviewResult.can_review,
    review_reason: reviewResult.reason,
    reviewer_name: reviewResult.reviewer_name,
    already_reviewed: reviewResult.already_reviewed
  };
}


// ═══════════════════════════════════════════════════════════════════════════════
// INTERNAL: getInvoiceReviewInternal
// ═══════════════════════════════════════════════════════════════════════════════
// Extracted logic for invoice review, called by getUserPermissions.
// Accepts pre-parsed user fields to avoid re-parsing.
function getInvoiceReviewInternal(data, userId, roles, isCeo, status) {
  var responsibleId   = data.responsible_id;
  var responsibleName = data.responsible_name || "";
  var alreadyReviewed = data.invoice_reviewed === true || data.invoice_reviewed === "true";

  // No responsible person assigned → review not required
  if (!responsibleId) {
    return {
      review_required: false, can_review: false,
      reason: "no_responsible_assigned", reviewer_name: null, already_reviewed: false
    };
  }

  // Already reviewed
  if (alreadyReviewed) {
    return {
      review_required: true, can_review: false,
      reason: "already_reviewed", reviewer_name: responsibleName, already_reviewed: true
    };
  }

  // Must be in Review/Submitted status for the button to show
  var reviewStatuses = ["review", "submitted", "submitted for review", "submitted - approval",
                        "pending_approval", "pending approval"];
  if (reviewStatuses.indexOf(status) === -1) {
    return {
      review_required: true, can_review: false,
      reason: "transaction_not_in_review", reviewer_name: responsibleName, already_reviewed: false
    };
  }

  // Check if current user is the responsible person
  if (sameUser(userId, responsibleId)) {
    return {
      review_required: true, can_review: true,
      reason: "user_is_responsible", reviewer_name: responsibleName, already_reviewed: false
    };
  }

  // CEO can also review
  if (isCeo) {
    return {
      review_required: true, can_review: true,
      reason: "user_is_ceo", reviewer_name: responsibleName, already_reviewed: false
    };
  }

  return {
    review_required: true, can_review: false,
    reason: "user_is_not_responsible", reviewer_name: responsibleName, already_reviewed: false
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
    case "canUserApprove":
      result = getApprovalProgress(data);  // superset
      break;
    case "getInvoiceReview":
      result = getUserPermissions(data);   // superset
      break;

    // ── Internal functions (for direct access if needed) ──
    case "getRequiredApprovers":
      result = getRequiredApprovers(data, mergedConfig);
      break;
    case "getApprovalStatus":
      result = getApprovalStatus(data);
      break;
    case "getNextPendingStep":
      result = getNextPendingStep(data);
      break;

    default:
      result = {
        error: "Unknown function: " + fn,
        available_functions: [
          "getApprovalChain",
          "getApprovalProgress",
          "validateSubmission",
          "getUserPermissions"
        ]
      };
  }

  return JSON.stringify(result);
};
