import Foundation

@MainActor
final class CalculatorViewModel: ObservableObject {
    @Published private(set) var displayText = "0"
    @Published private(set) var expressionText = ""
    @Published private(set) var history: [String] = []

    private var currentInput = "0"
    private var storedValue: Decimal?
    private var pendingOperation: Operation?
    private var shouldStartFreshInput = false

    enum Operation: String {
        case add = "+"
        case subtract = "−"
        case multiply = "×"
        case divide = "÷"
    }

    enum Key: String, Identifiable, CaseIterable {
        case clear = "AC"
        case sign = "±"
        case percent = "%"
        case divide = "÷"

        case seven = "7"
        case eight = "8"
        case nine = "9"
        case multiply = "×"

        case four = "4"
        case five = "5"
        case six = "6"
        case subtract = "−"

        case one = "1"
        case two = "2"
        case three = "3"
        case add = "+"

        case zero = "0"
        case decimal = "."
        case backspace = "⌫"
        case equals = "="

        var id: String { rawValue }

        var isOperation: Bool {
            [.divide, .multiply, .subtract, .add].contains(self)
        }
    }

    static let buttonLayout: [[Key]] = [
        [.clear, .sign, .percent, .divide],
        [.seven, .eight, .nine, .multiply],
        [.four, .five, .six, .subtract],
        [.one, .two, .three, .add],
        [.zero, .decimal, .backspace, .equals]
    ]

    func handleTap(_ key: Key) {
        switch key {
        case .clear:
            reset()
        case .sign:
            toggleSign()
        case .percent:
            percent()
        case .divide, .multiply, .subtract, .add:
            queueOperation(for: key)
        case .equals:
            resolveEquals()
        case .decimal:
            appendDecimal()
        case .backspace:
            backspace()
        default:
            appendDigit(key.rawValue)
        }

        displayText = formattedOutput(from: currentInput)
    }

    private func reset() {
        currentInput = "0"
        storedValue = nil
        pendingOperation = nil
        expressionText = ""
        shouldStartFreshInput = false
    }

    private func toggleSign() {
        guard currentInput != "0" else { return }
        if currentInput.hasPrefix("-") {
            currentInput.removeFirst()
        } else {
            currentInput = "-" + currentInput
        }
    }

    private func percent() {
        guard let value = decimal(from: currentInput) else { return }
        let result = value / 100
        currentInput = string(from: result)
    }

    private func appendDecimal() {
        if shouldStartFreshInput {
            currentInput = "0."
            shouldStartFreshInput = false
            return
        }

        if !currentInput.contains(".") {
            currentInput += "."
        }
    }

    private func appendDigit(_ digit: String) {
        if shouldStartFreshInput {
            currentInput = digit
            shouldStartFreshInput = false
            return
        }

        if currentInput == "0" {
            currentInput = digit
        } else {
            currentInput += digit
        }
    }

    private func backspace() {
        guard !shouldStartFreshInput else { return }
        currentInput = String(currentInput.dropLast())
        if currentInput.isEmpty || currentInput == "-" {
            currentInput = "0"
        }
    }

    private func queueOperation(for key: Key) {
        guard let selectedOperation = operation(for: key) else { return }

        if let pending = pendingOperation,
           let lhs = storedValue,
           let rhs = decimal(from: currentInput) {
            let result = perform(operation: pending, lhs: lhs, rhs: rhs)
            storedValue = result
            currentInput = string(from: result)
        } else {
            storedValue = decimal(from: currentInput)
        }

        pendingOperation = selectedOperation
        expressionText = "\(formattedOutput(from: currentInput)) \(selectedOperation.rawValue)"
        shouldStartFreshInput = true
    }

    private func resolveEquals() {
        guard let pending = pendingOperation,
              let lhs = storedValue,
              let rhs = decimal(from: currentInput) else { return }

        let result = perform(operation: pending, lhs: lhs, rhs: rhs)

        if result.isNaN {
            displayText = "Virhe"
            expressionText = "Nollalla ei voi jakaa"
            currentInput = "0"
            storedValue = nil
            pendingOperation = nil
            shouldStartFreshInput = true
            return
        }

        let lhsText = formattedOutput(from: string(from: lhs))
        let rhsText = formattedOutput(from: string(from: rhs))
        let resultText = formattedOutput(from: string(from: result))
        history.insert("\(lhsText) \(pending.rawValue) \(rhsText) = \(resultText)", at: 0)
        history = Array(history.prefix(8))

        currentInput = string(from: result)
        expressionText = "="
        storedValue = nil
        pendingOperation = nil
        shouldStartFreshInput = true
    }

    private func perform(operation: Operation, lhs: Decimal, rhs: Decimal) -> Decimal {
        switch operation {
        case .add:
            return lhs + rhs
        case .subtract:
            return lhs - rhs
        case .multiply:
            return lhs * rhs
        case .divide:
            guard rhs != 0 else {
                return Decimal.nan
            }
            return lhs / rhs
        }
    }

    private func operation(for key: Key) -> Operation? {
        switch key {
        case .add: return .add
        case .subtract: return .subtract
        case .multiply: return .multiply
        case .divide: return .divide
        default: return nil
        }
    }

    private func decimal(from value: String) -> Decimal? {
        Decimal(string: value)
    }

    private func string(from value: Decimal) -> String {
        NSDecimalNumber(decimal: value).stringValue
    }

    private func formattedOutput(from value: String) -> String {
        guard let number = Decimal(string: value) else { return value }
        let formatter = NumberFormatter()
        formatter.numberStyle = .decimal
        formatter.maximumFractionDigits = 10
        formatter.minimumFractionDigits = 0
        return formatter.string(from: NSDecimalNumber(decimal: number)) ?? value
    }
}
