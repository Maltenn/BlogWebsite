import CoreText
import UIKit

// The native tab bar (docs/mobile/deviations.md D3, D22, D23).
//
// It is NOT a UITabBar. UITabBar has a fixed 3-5 item model, its own label metrics, its own selection indicator and
// its own badge shape, and the site's `.ms-tabs` is up to twelve bold-12px items that scroll sideways, with a pink
// pill badge and an active tab that inverts to white. So this is a real UIScrollView of real UIControls — native hit
// testing, native rubber-band scrolling, native highlight, a haptic on tap — that draws what the web bar is.
//
// Nothing here decides what the bar looks like. Every rectangle, colour, string and baseline arrives in a TabSpec
// that public/js/core/tabspec.js MEASURED from the live `.ms-tabs` in this very web view, a few milliseconds earlier.
// That is what keeps the bar from drifting from app.css: change the CSS and the measurement changes with it, with no
// Swift touched. tools/tabbar-check.mjs proves (48 cases, both engines, 0 pixels) that a bar rebuilt from nothing but
// such a spec is pixel-identical to the web bar; what this file adds, and what only a device can confirm, is that
// Core Text puts the same glyphs on the same baselines as WKWebView does.
//
// Coordinates are CSS pixels, which on iOS are points: the web view is at scale 1 (D5 pins maximum-scale, and the
// page never zooms itself), so a point here is a CSS pixel there.

struct TabSpec: Decodable {
    struct Font: Decodable {
        let families: [String]
        let size: Double
        let weight: Double
        let italic: Bool
    }
    struct Rule: Decodable {
        let h: Double
        let color: String
    }
    struct Badge: Decodable {
        let s: String
        let x: Double, y: Double, w: Double, h: Double, r: Double
        let bg: String, fg: String
        let font: Font
        let textX: Double
        let baseline: Double
    }
    struct Item: Decodable {
        let id: String
        let href: String?
        let label: String
        let on: Bool
        let x: Double, y: Double, w: Double, h: Double
        let bg: String, fg: String
        let font: Font
        let textX: Double
        let baseline: Double
        let badge: Badge?
    }
    let v: Int
    let w: Double, h: Double, contentW: Double
    let bg: String
    let rule: Rule?
    let scrolls: Bool
    let items: [Item]

    static let supportedVersion = 2
}

// '#rrggbbaa' — the only colour form that crosses the bridge (tabspec.js `hex`). Anything else is clear, which shows
// up as a missing fill rather than a wrong one.
private func colour(_ hex: String) -> UIColor {
    var s = Substring(hex)
    if s.hasPrefix("#") { s = s.dropFirst() }
    guard s.count == 8, let v = UInt32(s, radix: 16) else { return .clear }
    return UIColor(
        red: CGFloat((v >> 24) & 0xff) / 255.0,
        green: CGFloat((v >> 16) & 0xff) / 255.0,
        blue: CGFloat((v >> 8) & 0xff) / 255.0,
        alpha: CGFloat(v & 0xff) / 255.0)
}

/* The font the WEB VIEW resolved, not a font chosen here. `families` is app.css's own list
   ('MS Sans Serif', Tahoma, 'Segoe UI', Arial, sans-serif); iOS has Arial and none of the first three, so Arial is
   what WKWebView picks and what this picks, by walking the same list in the same order. The generic keywords fall
   through to the bold system font, which is also what the web view does with them. (deviations.md D4.) */
private let genericFamilies: Set<String> = [
    "serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui",
    "ui-serif", "ui-sans-serif", "ui-monospace", "ui-rounded", "math", "emoji", "fangsong",
]

private func font(_ spec: TabSpec.Font) -> UIFont {
    let size = CGFloat(spec.size)
    var traits: UIFontDescriptor.SymbolicTraits = []
    if spec.weight >= 600 { traits.insert(.traitBold) }
    if spec.italic { traits.insert(.traitItalic) }

    var chosen: UIFont?
    for family in spec.families {
        if genericFamilies.contains(family.lowercased()) { break }   // the generics end the list: fall through
        guard UIFont.familyNames.contains(where: { $0.caseInsensitiveCompare(family) == .orderedSame }) else { continue }
        let base = UIFontDescriptor(fontAttributes: [.family: family])
        let descriptor = base.withSymbolicTraits(traits) ?? base
        chosen = UIFont(descriptor: descriptor, size: size)
        break
    }
    // UIKit caches font instances itself, so this is not cached here: a global cache would be shared mutable state
    // for the sake of a lookup that happens a dozen times per redraw.
    return chosen ?? UIFont.systemFont(ofSize: size, weight: spec.weight >= 600 ? .bold : .regular)
}

/// One tab. A UIControl, so it has the system's own touch handling: a press highlights it, a drag out of it cancels,
/// VoiceOver sees a button with the tab's label.
final class OSTabItemView: UIControl {
    private(set) var item: TabSpec.Item
    var onTap: ((TabSpec.Item) -> Void)?

    init(item: TabSpec.Item) {
        self.item = item
        super.init(frame: .zero)
        backgroundColor = .clear
        isOpaque = false
        contentMode = .redraw
        accessibilityTraits = .button
        addTarget(self, action: #selector(tapped), for: .touchUpInside)
        apply(item)
    }

    required init?(coder: NSCoder) { fatalError("not from a nib") }

    func apply(_ next: TabSpec.Item) {
        item = next
        accessibilityLabel = next.label.trimmingCharacters(in: .whitespacesAndNewlines)
        if next.on { accessibilityTraits.insert(.selected) } else { accessibilityTraits.remove(.selected) }
        setNeedsDisplay()
    }

    @objc private func tapped() { onTap?(item) }

    override var isHighlighted: Bool {
        didSet {
            // the web bar's own `.ms-tab:hover { background: #4477aa }` has no touch equivalent; a brief dim is the
            // native stand-in and is listed as a deviation (D23) rather than pretended away
            alpha = isHighlighted ? 0.6 : 1.0
        }
    }

    /* Drawn rather than built from UILabels because the spec gives BASELINES, and a UILabel places its text by its own
       vertical centring rules. Core Text is what takes a baseline directly (`CGContext.textPosition` IS the baseline
       origin), which is why it is used here instead of `NSAttributedString.draw(at:)`: that one positions the top of
       the line fragment, so the baseline would come out a fraction low wherever the run's tallest font is not the
       label's — which is exactly the two tabs whose label starts with an emoji. */
    override func draw(_ rect: CGRect) {
        guard let ctx = UIGraphicsGetCurrentContext() else { return }
        // the tab's own background, in the tab's own coordinates (the frame already carries x/y/w/h)
        let bg = colour(item.bg)
        if bg.cgColor.alpha > 0 {
            ctx.setFillColor(bg.cgColor)
            ctx.fill(CGRect(x: 0, y: 0, width: bounds.width, height: bounds.height))
        }
        // the label: the spec's text x and baseline, both relative to the bar, made relative to this tab
        drawRun(item.label, x: item.textX - item.x, baseline: item.baseline - item.y, font: font(item.font), colour: colour(item.fg))

        if let badge = item.badge {
            let pill = CGRect(x: badge.x - item.x, y: badge.y - item.y, width: badge.w, height: badge.h)
            let radius = min(CGFloat(badge.r), pill.height / 2)
            ctx.setFillColor(colour(badge.bg).cgColor)
            UIBezierPath(roundedRect: pill, cornerRadius: radius).fill()
            drawRun(badge.s, x: badge.textX - item.x, baseline: badge.baseline - item.y, font: font(badge.font), colour: colour(badge.fg))
        }
    }

    private func drawRun(_ s: String, x: Double, baseline: Double, font: UIFont, colour: UIColor) {
        guard !s.isEmpty, let ctx = UIGraphicsGetCurrentContext() else { return }
        let attributed = NSAttributedString(string: s, attributes: [
            .font: font,
            .foregroundColor: colour,
            kCTForegroundColorAttributeName as NSAttributedString.Key: colour.cgColor,
        ])
        let line = CTLineCreateWithAttributedString(attributed)
        ctx.saveGState()
        // Core Text draws in a bottom-up space; UIView's is top-down, so flip, and give the baseline in that space
        ctx.textMatrix = .identity
        ctx.translateBy(x: 0, y: bounds.height)
        ctx.scaleBy(x: 1, y: -1)
        ctx.textPosition = CGPoint(x: CGFloat(x), y: bounds.height - CGFloat(baseline))
        CTLineDraw(line, ctx)
        ctx.restoreGState()
    }
}

/// The bar: a scroll view of tabs, with the site's background behind them and its 1px rule underneath.
final class OSTabBarView: UIView {
    private let scroller = UIScrollView()
    private let canvas = UIView()
    private let rule = UIView()
    private var views: [OSTabItemView] = []
    private(set) var spec: TabSpec?
    var onTap: ((TabSpec.Item) -> Void)?

    /// The height the shell must reserve: the bar plus its rule. 0 when there is nothing to draw.
    var barHeight: CGFloat {
        guard let spec = spec else { return 0 }
        return CGFloat(spec.h + (spec.rule?.h ?? 0))
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        isOpaque = false
        scroller.showsHorizontalScrollIndicator = false       // `.ms-tabs` hides its scrollbar (scrollbar-width: none)
        scroller.showsVerticalScrollIndicator = false
        scroller.alwaysBounceHorizontal = false
        scroller.contentInsetAdjustmentBehavior = .never
        scroller.delaysContentTouches = false                  // a tab reacts on touch-down, as a native bar does
        addSubview(scroller)
        scroller.addSubview(canvas)
        addSubview(rule)
    }

    required init?(coder: NSCoder) { fatalError("not from a nib") }

    /// Draw this spec, or nil to show nothing. Returns true when the height changed and the shell must lay out again.
    @discardableResult
    func show(_ next: TabSpec?) -> Bool {
        let was = barHeight
        guard let next = next, next.v == TabSpec.supportedVersion, !next.items.isEmpty else {
            spec = nil
            views.forEach { $0.removeFromSuperview() }
            views = []
            isHidden = true
            return was != 0
        }
        spec = next
        isHidden = false
        canvas.backgroundColor = colour(next.bg)
        rule.backgroundColor = next.rule.map { colour($0.color) } ?? .clear
        rule.isHidden = next.rule == nil

        // reuse the item views when the shape of the bar has not changed, so a new unread count does not rebuild it
        if views.count != next.items.count {
            views.forEach { $0.removeFromSuperview() }
            views = next.items.map { item in
                let v = OSTabItemView(item: item)
                v.onTap = { [weak self] in self?.onTap?($0) }
                canvas.addSubview(v)
                return v
            }
        } else {
            for (v, item) in zip(views, next.items) { v.apply(item) }
        }
        setNeedsLayout()
        layoutIfNeeded()
        scrollActiveIntoView()
        return barHeight != was
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        guard let spec = spec else { return }
        let h = CGFloat(spec.h)
        let ruleH = CGFloat(spec.rule?.h ?? 0)
        scroller.frame = CGRect(x: 0, y: 0, width: bounds.width, height: h)
        let content = CGFloat(max(spec.contentW, spec.w))
        canvas.frame = CGRect(x: 0, y: 0, width: max(content, bounds.width), height: h)
        scroller.contentSize = canvas.frame.size
        scroller.isScrollEnabled = canvas.frame.width > bounds.width
        for (v, item) in zip(views, spec.items) {
            v.frame = CGRect(x: CGFloat(item.x), y: CGFloat(item.y), width: CGFloat(item.w), height: CGFloat(item.h))
        }
        rule.frame = CGRect(x: 0, y: h, width: bounds.width, height: ruleH)
    }

    /// The active tab is brought into view, which the web bar does not do and a native bar is expected to.
    private func scrollActiveIntoView() {
        guard scroller.isScrollEnabled,
              let i = spec?.items.firstIndex(where: { $0.on }),
              i < views.count else { return }
        scroller.scrollRectToVisible(views[i].frame.insetBy(dx: -8, dy: 0), animated: false)
    }
}
