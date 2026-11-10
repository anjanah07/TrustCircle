export type DemoMember = {
  name: string;
  deposited: boolean;
  paid: boolean;
  collateral: number;
  received: number;
  won: boolean;
  discount: number | null;
  notice: string;
  defaults: number;
  barred: boolean;
};
export type DemoTransaction = {
  sequence: number;
  member: string;
  kind: string;
  amount: number;
};
export type DemoState = {
  members: DemoMember[];
  phase: "deposits" | "collecting" | "bidding" | "settled" | "paused";
  round: number;
  deadline: number | null;
  transactions: DemoTransaction[];
  decisions: string[];
};
export function initialDemo(): DemoState {
  return {
    members: ["Ananya", "Rohan", "Meera", "Arjun", "Sara"].map((name) => ({
      name,
      deposited: false,
      paid: false,
      collateral: 0,
      received: 0,
      won: false,
      discount: null,
      notice: "",
      defaults: 0,
      barred: false,
    })),
    phase: "deposits",
    round: 1,
    deadline: null,
    transactions: [],
    decisions: [
      "Waiting for five collateral deposits. All balances in this walkthrough are simulated.",
    ],
  };
}
export type DemoAction =
  | { type: "deposit"; member: number }
  | { type: "pay"; member: number }
  | { type: "bid"; member: number; discount: number }
  | { type: "tick" }
  | { type: "next" };
export function demoStep(
  previous: DemoState,
  action: DemoAction,
  now: number,
): DemoState {
  const state: DemoState = structuredClone(previous);
  const record = (index: number, kind: string, amount: number) =>
    state.transactions.push({
      sequence: state.transactions.length + 1,
      member: state.members[index].name,
      kind,
      amount,
    });
  if (action.type === "deposit" && state.phase === "deposits") {
    const member = state.members[action.member];
    if (!member || member.deposited) return previous;
    member.deposited = true;
    member.collateral = 150000;
    record(action.member, "Collateral to Treasurer", 150000);
    if (state.members.every((member) => member.deposited)) {
      state.phase = "collecting";
      state.deadline = now + 55000;
      state.decisions.unshift(
        "All five collateral deposits received. Round 1 activated: 25 seconds to contribute, plus 30 seconds grace.",
      );
    }
  }
  if (action.type === "pay" && state.phase === "collecting" && now < state.deadline!) {
    const member = state.members[action.member];
    if (!member || member.paid) return previous;
    member.paid = true;
    record(action.member, "Contribution to Treasurer", 50000);
  }
  if (state.phase === "collecting" && now >= state.deadline!) {
    state.members.forEach((member, index) => {
      if (member.paid) return;
      member.paid = true;
      member.collateral -= 55000;
      member.defaults++;
      member.notice =
        "$500 contribution and $50 late fee deducted from your deposited collateral.";
      record(index, "Contribution from collateral", 50000);
      record(index, "Late fee from collateral", 5000);
      if (member.defaults >= 2) {
        member.barred = true;
        member.notice +=
          " You are barred after two defaults. Remaining funds are preserved for settlement.";
        state.phase = "paused";
        state.deadline = null;
        state.decisions.unshift(
          `${member.name} barred after two verified defaults. Circle paused for reconciliation; remaining collateral is preserved.`,
        );
      }
      state.decisions.unshift(
        `${member.name} missed the grace deadline. Covered the contribution and late fee from collateral.`,
      );
    });
  }
  if (state.phase === "collecting" && state.members.every((member) => member.paid)) {
    state.phase = "bidding";
    state.deadline = now + 60000;
    state.decisions.unshift(
      "The $2,500 pot is funded. Opening a 60-second request window. Previous winners are ineligible; highest discount wins.",
    );
  }
  if (action.type === "bid" && state.phase === "bidding" && now < state.deadline!) {
    const member = state.members[action.member];
    if (
      !member ||
      member.won ||
      !Number.isInteger(action.discount) ||
      action.discount < 0 ||
      action.discount >= 250000
    )
      return previous;
    member.discount = action.discount;
  }
  if (state.phase === "bidding" && now >= state.deadline!) {
    const eligible = state.members
      .map((member, index) => ({ ...member, index }))
      .filter((member) => !member.won);
    const requests = eligible
      .filter((member) => member.discount !== null)
      .sort((a, b) => b.discount! - a.discount! || a.index - b.index);
    const winner = requests[0] || eligible[0];
    if (!winner) return previous;
    const discount = winner.discount || 0;
    const net = 250000 - discount;
    const retained = Math.min(
      net,
      Math.max(0, (5 - state.round) * 50000 - winner.collateral),
    );
    state.members[winner.index].won = true;
    state.members[winner.index].received += net - retained;
    record(winner.index, "Winner payout", net - retained);
    if (retained) record(winner.index, "Retained to secure future rounds", retained);
    let remainder = discount % 4;
    state.members.forEach((member, index) => {
      if (index === winner.index || !discount) return;
      const share = Math.floor(discount / 4) + (remainder-- > 0 ? 1 : 0);
      member.received += share;
      record(index, "Discount dividend", share);
    });
    state.decisions.unshift(
      `${winner.name} selected ${requests.length ? "by highest discount (ties use member order in this walkthrough)" : "by rotation: no requests received"}. Discount $${(discount / 100).toFixed(2)} split among the other four members. $${(retained / 100).toFixed(2)} retained to secure future contributions. Simulated payout $${((net - retained) / 100).toFixed(2)}.`,
    );
    state.phase = "settled";
    state.deadline = null;
  }
  if (action.type === "next" && state.phase === "settled" && state.round < 2) {
    state.round++;
    state.phase = "collecting";
    state.deadline = now + 55000;
    state.members.forEach((member) => {
      member.paid = false;
      member.discount = null;
      member.notice = "";
    });
    state.decisions.unshift(
      "Round 2 started. The previous winner cannot request another payout. This guided preview covers two rounds.",
    );
  }
  return state;
}
