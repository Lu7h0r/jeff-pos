// Commission split calculator for Batch 8 service sales.
//
// All amounts are integer minor units (e.g. centavos). Staff share is rounded
// DOWN (Math.floor) and the house always receives the cent-level remainder so
// the sum is exactly the gross amount and the platform never owes more than
// what was actually charged. Documented MVP choice — owner can override
// downstream by editing the commission_estimate manually.
//
// `manual` returns staff=0 + house=0 to flag that a human decision is
// pending; UI should prompt for an explicit split before liquidation.
export type CommissionSplitKind =
  | "staff_30_house_70"
  | "staff_50_house_50"
  | "staff_70_house_30"
  | "owner_direct"
  | "manual";

export interface CommissionShares {
  staff: number;
  house: number;
}

export function computeShares(
  grossAmount: number,
  splitKind: string,
): CommissionShares {
  switch (splitKind) {
    case "staff_30_house_70": {
      const staff = Math.floor(grossAmount * 0.3);
      return { staff, house: grossAmount - staff };
    }
    case "staff_50_house_50": {
      const staff = Math.floor(grossAmount * 0.5);
      return { staff, house: grossAmount - staff };
    }
    case "staff_70_house_30": {
      const staff = Math.floor(grossAmount * 0.7);
      return { staff, house: grossAmount - staff };
    }
    case "owner_direct":
      return { staff: 0, house: grossAmount };
    case "manual":
      return { staff: 0, house: 0 };
    default:
      throw new Error(`unknown commission split: ${splitKind}`);
  }
}
