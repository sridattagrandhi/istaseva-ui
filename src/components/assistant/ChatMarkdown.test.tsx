import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ChatMarkdown, stripChatMarkdown } from "./ChatMarkdown";

describe("ChatMarkdown", () => {
  it("renders plain single-line text verbatim", () => {
    render(<ChatMarkdown text="Namaskaram! How can I help?" />);
    expect(screen.getByText("Namaskaram! How can I help?")).toBeInTheDocument();
  });

  it("renders **bold** spans as semibold without the asterisks", () => {
    const { container } = render(<ChatMarkdown text="Total is **₹2,500** for 2 nights" />);
    const strong = container.querySelector("strong");
    expect(strong).not.toBeNull();
    expect(strong!.textContent).toBe("₹2,500");
    expect(container.textContent).not.toContain("**");
  });

  it("renders * and - bullets as • with the marker stripped", () => {
    const { container } = render(
      <ChatMarkdown text={"Found two stays:\n* **Taj Goa** — ₹4,000/night\n- Sea Breeze — ₹2,200/night"} />,
    );
    expect(container.textContent).not.toContain("* ");
    expect(container.textContent).not.toContain("- Sea");
    const markers = [...container.querySelectorAll("span")].filter((s) => s.textContent === "•");
    expect(markers).toHaveLength(2);
    expect(container.querySelector("strong")!.textContent).toBe("Taj Goa");
  });

  it("keeps numbered-list markers", () => {
    const { container } = render(<ChatMarkdown text={"Steps:\n1. Pick a date\n2. Confirm"} />);
    const markers = [...container.querySelectorAll("span")].map((s) => s.textContent);
    expect(markers).toContain("1.");
    expect(markers).toContain("2.");
  });

  it("re-breaks newline-collapsed voice-transcript bullets into list rows", () => {
    // Real shape from a Gemini Live transcript: the model emitted a markdown
    // list but the newlines were lost in transit, leaving orphan asterisks.
    const { container } = render(
      <ChatMarkdown text={"Sure, here's a quick overview:* **Garden Court Palace:** has a gym, starts at ₹4,496/night.* **Lake View Regency:** offers breakfast, starting at ₹2,743/night."} />,
    );
    expect(container.textContent).not.toContain(":*");
    expect(container.textContent).not.toContain(".*");
    const markers = [...container.querySelectorAll("span")].filter((s) => s.textContent === "•");
    expect(markers).toHaveLength(2);
    const bold = [...container.querySelectorAll("strong")].map((s) => s.textContent);
    expect(bold).toEqual(["Garden Court Palace:", "Lake View Regency:"]);
  });

  it("does not treat arithmetic asterisks as collapsed bullets", () => {
    const { container } = render(<ChatMarkdown text="That's 2 * 3 nights at ₹500" />);
    expect(container.textContent).toBe("That's 2 * 3 nights at ₹500");
  });

  it("never interprets HTML in the message", () => {
    const { container } = render(<ChatMarkdown text={'<img src=x onerror=alert(1)> **hi**'} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("<img src=x onerror=alert(1)>");
  });
});

describe("stripChatMarkdown", () => {
  it("drops bullet markers and bold asterisks for TTS", () => {
    expect(stripChatMarkdown("* **Taj Goa** — ₹4,000\n* Sea Breeze")).toBe(
      "Taj Goa — ₹4,000. Sea Breeze",
    );
  });

  it("passes plain text through", () => {
    expect(stripChatMarkdown("Booked! See you in Goa.")).toBe("Booked! See you in Goa.");
  });

  it("drops collapsed inline bullet markers so TTS never says 'asterisk'", () => {
    expect(stripChatMarkdown("Here's an overview.* **Taj Goa:** pool.* **Sea Breeze:** spa.")).toBe(
      "Here's an overview. Taj Goa: pool. Sea Breeze: spa.",
    );
  });
});
