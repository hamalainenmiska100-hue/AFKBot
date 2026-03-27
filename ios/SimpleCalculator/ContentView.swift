import SwiftUI

struct ContentView: View {
    @StateObject private var viewModel = CalculatorViewModel()

    private let columns = Array(repeating: GridItem(.flexible(), spacing: 12), count: 4)

    var body: some View {
        ZStack {
            Color.black
                .opacity(0.94)
                .ignoresSafeArea()

            // iOS 26-inspired liquid glass blobs (no gradients).
            Circle()
                .fill(.white.opacity(0.08))
                .frame(width: 340, height: 340)
                .blur(radius: 60)
                .offset(x: -130, y: -260)

            Circle()
                .fill(.cyan.opacity(0.10))
                .frame(width: 320, height: 320)
                .blur(radius: 70)
                .offset(x: 180, y: 280)

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
                .foregroundStyle(.white.opacity(0.96))

            Text("iOS 26 Liquid Glass")
                .font(.caption.weight(.medium))
                .foregroundStyle(.white.opacity(0.55))

            if !viewModel.history.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 10) {
                        ForEach(viewModel.history, id: \.self) { item in
                            Text(item)
                                .font(.caption)
                                .padding(.horizontal, 12)
                                .padding(.vertical, 8)
                                .background(.ultraThinMaterial, in: Capsule())
                                .overlay(
                                    Capsule()
                                        .stroke(.white.opacity(0.14), lineWidth: 0.9)
                                )
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
                .foregroundStyle(.white.opacity(0.74))
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
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 26, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 26, style: .continuous)
                .stroke(.white.opacity(0.16), lineWidth: 1)
        )
        .shadow(color: .black.opacity(0.28), radius: 16, x: 0, y: 8)
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
            .background(
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .fill(.ultraThinMaterial)
                    .overlay(
                        RoundedRectangle(cornerRadius: 18, style: .continuous)
                            .fill(tintColor.opacity(configuration.isPressed ? 0.32 : 0.22))
                    )
            )
            .overlay(
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .stroke(.white.opacity(configuration.isPressed ? 0.28 : 0.14), lineWidth: 1)
            )
            .shadow(color: .black.opacity(configuration.isPressed ? 0.10 : 0.22), radius: configuration.isPressed ? 4 : 8, x: 0, y: configuration.isPressed ? 2 : 4)
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .animation(.spring(response: 0.22, dampingFraction: 0.74), value: configuration.isPressed)
    }

    private var foregroundColor: Color {
        .white
    }

    private var tintColor: Color {
        switch role {
        case .number:
            return .white
        case .utility:
            return Color(red: 0.70, green: 0.76, blue: 0.90)
        case .operation:
            return Color(red: 0.62, green: 0.68, blue: 0.98)
        case .equals:
            return Color(red: 0.46, green: 0.86, blue: 0.80)
        }
    }
}

#Preview {
    ContentView()
}
