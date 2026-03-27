import SwiftUI

struct ContentView: View {
    @StateObject private var viewModel = CalculatorViewModel()

    private let columns = Array(repeating: GridItem(.flexible(), spacing: 12), count: 4)

    var body: some View {
        ZStack {
            LinearGradient(
                colors: [Color(red: 0.12, green: 0.14, blue: 0.26), Color(red: 0.04, green: 0.04, blue: 0.08)],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
            .ignoresSafeArea()

            VStack(spacing: 16) {
                header
                display
                keypad
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 24)
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Simple Calculator")
                .font(.title2.bold())
                .foregroundStyle(.white.opacity(0.95))

            if !viewModel.history.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 10) {
                        ForEach(viewModel.history, id: \.self) { item in
                            Text(item)
                                .font(.caption)
                                .padding(.horizontal, 12)
                                .padding(.vertical, 8)
                                .background(.white.opacity(0.12), in: Capsule())
                        }
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var display: some View {
        VStack(alignment: .trailing, spacing: 8) {
            Text(viewModel.expressionText)
                .font(.headline)
                .foregroundStyle(.white.opacity(0.75))
                .lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .trailing)

            Text(viewModel.displayText)
                .font(.system(size: 52, weight: .semibold, design: .rounded))
                .foregroundStyle(.white)
                .lineLimit(1)
                .minimumScaleFactor(0.45)
                .frame(maxWidth: .infinity, alignment: .trailing)
        }
        .padding(18)
        .background(.ultraThinMaterial.opacity(0.8), in: RoundedRectangle(cornerRadius: 24, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 24, style: .continuous)
                .stroke(.white.opacity(0.08), lineWidth: 1)
        )
    }

    private var keypad: some View {
        LazyVGrid(columns: columns, spacing: 12) {
            ForEach(CalculatorViewModel.buttonLayout.flatMap { $0 }) { key in
                Button {
                    viewModel.handleTap(key)
                } label: {
                    Text(key.rawValue)
                        .font(.title3.weight(.semibold))
                        .frame(maxWidth: .infinity)
                        .frame(height: 62)
                }
                .buttonStyle(CalculatorButtonStyle(role: role(for: key)))
            }
        }
    }

    private func role(for key: CalculatorViewModel.Key) -> CalculatorButtonStyle.Role {
        switch key {
        case .equals:
            return .equals
        case .add, .subtract, .multiply, .divide:
            return .operation
        case .clear, .sign, .percent, .backspace:
            return .utility
        default:
            return .number
        }
    }
}

private struct CalculatorButtonStyle: ButtonStyle {
    enum Role {
        case number
        case operation
        case utility
        case equals
    }

    let role: Role

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(foregroundColor)
            .background(background(configuration.isPressed), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .stroke(.white.opacity(configuration.isPressed ? 0.22 : 0.1), lineWidth: 1)
            )
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .animation(.spring(response: 0.22, dampingFraction: 0.74), value: configuration.isPressed)
    }

    private var foregroundColor: Color {
        switch role {
        case .utility:
            return .white.opacity(0.95)
        default:
            return .white
        }
    }

    private func background(_ pressed: Bool) -> LinearGradient {
        let colors: [Color]
        switch role {
        case .number:
            colors = [Color.white.opacity(0.20), Color.white.opacity(0.08)]
        case .utility:
            colors = [Color(red: 0.35, green: 0.35, blue: 0.45), Color(red: 0.22, green: 0.22, blue: 0.30)]
        case .operation:
            colors = [Color(red: 0.61, green: 0.45, blue: 0.98), Color(red: 0.36, green: 0.22, blue: 0.86)]
        case .equals:
            colors = [Color(red: 0.17, green: 0.74, blue: 0.67), Color(red: 0.06, green: 0.53, blue: 0.56)]
        }

        return LinearGradient(
            colors: pressed ? colors.map { $0.opacity(0.75) } : colors,
            startPoint: .topLeading,
            endPoint: .bottomTrailing
        )
    }
}

#Preview {
    ContentView()
}
