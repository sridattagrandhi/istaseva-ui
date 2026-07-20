/** Maps service categories/subcategories to guarantee periods */

export interface GuaranteeInfo {
  months: number;
  label: string;
  description: string;
}

const categoryGuarantees: Record<string, GuaranteeInfo> = {
  "Electrical": { months: 6, label: "6-Month Guarantee", description: "All electrical work is guaranteed for 6 months. If any issue arises from the service performed, we'll fix it free of charge." },
  "Plumbing": { months: 6, label: "6-Month Guarantee", description: "Plumbing repairs and installations come with a 6-month workmanship guarantee covering leaks and fitting issues." },
  "Carpentry": { months: 3, label: "3-Month Guarantee", description: "Carpentry work is backed by a 3-month guarantee on structural integrity and finishing quality." },
  "Painting": { months: 3, label: "3-Month Guarantee", description: "Paint jobs include a 3-month guarantee against peeling, bubbling, or uneven coverage." },
  "Appliance Repair": { months: 3, label: "3-Month Guarantee", description: "Appliance repairs carry a 3-month guarantee. If the same issue recurs, we'll fix it at no extra cost." },
  "AC Service": { months: 3, label: "3-Month Guarantee", description: "AC servicing and repairs are guaranteed for 3 months, covering the same issue if it reoccurs." },
  "Home Cleaning": { months: 0, label: "", description: "" },
  "Pest Control": { months: 1, label: "30-Day Guarantee", description: "Pest control treatments come with a 30-day effectiveness guarantee. If pests return within 30 days, we'll re-treat for free." },
};

export function getServiceGuarantee(category: string, subcategory?: string): GuaranteeInfo | null {
  // Check subcategory first for more specific match
  if (subcategory && categoryGuarantees[subcategory] && categoryGuarantees[subcategory].months > 0) {
    return categoryGuarantees[subcategory];
  }
  const info = categoryGuarantees[category];
  if (info && info.months > 0) return info;
  return null;
}
