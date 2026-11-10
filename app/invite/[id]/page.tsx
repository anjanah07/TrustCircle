import AccountGate from "../../../components/AccountGate";
export const metadata = {
  title: "Circle invitation | TrustCircle",
  referrer: "no-referrer" as const,
};
export default function InvitePage() {
  return <AccountGate />;
}
