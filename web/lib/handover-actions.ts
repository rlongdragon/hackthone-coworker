"use server";

import { revalidatePath } from "next/cache";
import { requireEmployee } from "@/lib/authz";
import {
  approveAndRunHandover,
  createHandover,
  deactivateEmployee,
  reactivateEmployee,
  rejectHandover,
  type HandoverInclude,
} from "@/lib/handover-store";
import {
  analyzeHandoverGaps,
  answerQuestion,
  askSuccessorQuestion,
  submitFollowup,
} from "@/lib/handover-gaps";

function assertInitiator(role: string) {
  if (role !== "admin" && role !== "manager") throw new Error("需要管理員或主管權限");
}

export async function createHandoverAction(input: {
  fromEmployeeId: string;
  toEmployeeId: string;
  scope: "all" | "project";
  projectId?: string | null;
  include: HandoverInclude;
  custodial?: boolean;
  parentHandoverId?: string | null;
}): Promise<{ ok: boolean; message: string }> {
  const user = await requireEmployee();
  assertInitiator(user.role);
  const r = await createHandover({ createdBy: user.id, ...input });
  if ("error" in r) {
    revalidatePath("/admin/handover");
    return { ok: false, message: r.error };
  }
  // v2-B: run the gap analysis right away so the interview questions and the
  // completeness score are on the table before anyone approves. A second
  // stage skips it — it forwards the original leaver's package; interviewing
  // the custodian about their own job would pollute it.
  const gap = input.parentHandoverId ? null : await analyzeHandoverGaps(r.id, user.id);
  revalidatePath("/admin/handover");
  const gapNote = !gap
    ? "二次交接:轉移原暫存包,不另做缺口分析"
    : gap.ok
      ? `缺口分析:覆蓋度 ${gap.report.score}%、${gap.report.gaps.length} 題訪談題已送交出者`
      : "(缺口分析暫時失敗,可稍後在列表重跑)";
  return {
    ok: true,
    message:
      (r.approver === "from-employee"
        ? "已建立,等待交出者本人核可(在他的「今日總覽」頁)"
        : "已建立,交出者已停用 — 需另一位管理員在此頁核可") + `;${gapNote}`,
  };
}

// v2-B: (re)run the knowledge-gap analysis for one handover.
export async function analyzeGapsAction(
  handoverId: string,
): Promise<{ ok: boolean; message: string }> {
  const user = await requireEmployee();
  assertInitiator(user.role);
  const r = await analyzeHandoverGaps(handoverId, user.id);
  revalidatePath("/admin/handover");
  revalidatePath("/me");
  if (!r.ok) return { ok: false, message: r.error };
  return {
    ok: true,
    message: `覆蓋度 ${r.report.score}%,產生 ${r.report.gaps.length} 題訪談題`,
  };
}

// v2-A: the leaver answers (empty answer = skip) one interview question.
export async function answerQuestionAction(
  questionId: string,
  answer: string,
): Promise<{ ok: boolean; message: string }> {
  const user = await requireEmployee();
  const r = await answerQuestion(questionId, user.id, answer);
  revalidatePath("/me");
  revalidatePath("/admin/handover");
  return r;
}

// v2-C: the successor routes a question to the leaver from the /me card.
export async function askPredecessorAction(
  handoverId: string,
  question: string,
): Promise<{ ok: boolean; message: string }> {
  const user = await requireEmployee();
  const r = await askSuccessorQuestion(handoverId, user.id, question);
  revalidatePath("/me");
  return r;
}

// v2-F: 30-day follow-up from the successor.
export async function submitFollowupAction(
  handoverId: string,
  stuckPoints: string,
): Promise<{ ok: boolean; message: string }> {
  const user = await requireEmployee();
  const r = await submitFollowup(handoverId, user.id, stuckPoints);
  revalidatePath("/me");
  return r;
}

export async function approveHandoverAction(
  handoverId: string,
): Promise<{ ok: boolean; message: string }> {
  const user = await requireEmployee();
  const r = await approveAndRunHandover(handoverId, user.id, user.role);
  revalidatePath("/admin/handover");
  revalidatePath("/me");
  return r;
}

export async function rejectHandoverAction(
  handoverId: string,
): Promise<{ ok: boolean; message: string }> {
  const user = await requireEmployee();
  const r = await rejectHandover(handoverId, user.id, user.role);
  revalidatePath("/admin/handover");
  revalidatePath("/me");
  return r;
}

export async function deactivateEmployeeAction(
  targetId: string,
): Promise<{ ok: boolean; message: string }> {
  const user = await requireEmployee();
  if (user.role !== "admin") return { ok: false, message: "需要管理員權限" };
  const r = await deactivateEmployee(targetId, user.id);
  revalidatePath("/admin/handover");
  return r;
}

export async function reactivateEmployeeAction(
  targetId: string,
): Promise<{ ok: boolean; message: string }> {
  const user = await requireEmployee();
  if (user.role !== "admin") return { ok: false, message: "需要管理員權限" };
  const r = await reactivateEmployee(targetId, user.id);
  revalidatePath("/admin/handover");
  return r;
}
