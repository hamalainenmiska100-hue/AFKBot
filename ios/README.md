# iOS Simple Calculator

Moderni SwiftUI-laskin iOS:lle:

- laskee perusoperaatiot (`+`, `−`, `×`, `÷`)
- sisältää prosentti-, etumerkki- ja backspace-toiminnot
- näyttää laskuhistorian
- käyttää modernia gradient + glassmorphism -UI:ta

## Rakenne

- `ios/SimpleCalculator/CalculatorApp.swift` – app entry
- `ios/SimpleCalculator/ContentView.swift` – UI + näppäimistö
- `ios/SimpleCalculator/CalculatorViewModel.swift` – laskentalogiikka
- `ios/project.yml` – XcodeGen-määrittely iOS-projektille
- `.github/workflows/ios_unsigned_ipa.yml` – GitHub Actions joka tuottaa unsigned IPA -artifactin

## Paikallinen build (macOS)

```bash
brew install xcodegen
cd ios
xcodegen generate
xcodebuild -project SimpleCalculator.xcodeproj -scheme SimpleCalculator -configuration Release -sdk iphoneos -derivedDataPath build CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY="" build
```

## Unsigned IPA paketointi

```bash
mkdir -p output/Payload
cp -R build/Build/Products/Release-iphoneos/SimpleCalculator.app output/Payload/
cd output && zip -r SimpleCalculator-unsigned.ipa Payload
```

## GitHub Actions artifact

Kun pushaat muutokset, workflow **Build unsigned iOS IPA** ajaa buildin macOS-runnerilla ja julkaisee artifactin:

- `SimpleCalculator-unsigned-ipa`
- sisältö: `SimpleCalculator-unsigned.ipa`
