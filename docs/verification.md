# Weryfikacja Huawei FusionSolar Monitor 0.1.0

Zakres: plugin tylko do odczytu. Falownik SUN2000, licznik, bieżące skalarne KPI instalacji/urządzeń i aktywne alarmy. Controller for HomeKit jest planowanym widokiem danych rozszerzonych. Nie powstał osobny interfejs graficzny aplikacji.

## Końcowe polecenia i wyniki

Pełna weryfikacja na Node.js 24.11.1 (kod zakończenia 0):

```text
npm run verify
> npm run typecheck && npm run lint && npm run build && npm test

npm run typecheck
> tsc -p tsconfig.json --noEmit
exit 0

npm run lint
> eslint src
exit 0

npm run build
> tsc -p tsconfig.json
exit 0

npm test
> node --test tests/*.test.mjs
ℹ tests 70
ℹ pass 70
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
```

Ponowne sprawdzenie na najstarszym deklarowanym Node.js 22.12.0 (kod zakończenia 0):

```text
node --test tests/*.test.mjs
# tests 70
# pass 70
# fail 0
# cancelled 0
# skipped 0
```

Audyt wszystkich zainstalowanych zależności, także deweloperskich (kod zakończenia 0):

```text
npm audit --json --cache /private/tmp/fusionsolar-npm-cache
"vulnerabilities": {}
"total": 0
```

Pakowanie (kod zakończenia 0):

```text
npm pack --json --cache /private/tmp/fusionsolar-npm-cache --pack-destination ../../outputs
"filename": "homebridge-huawei-fusionsolar-monitor-0.1.0.tgz"
"size": 25855
"entryCount": 22
"bundled": []
```

Dodatkowo porównano bajt po bajcie wszystkie 22 pliki w końcowym archiwum z plikami projektu. Potwierdzono brak zależności wykonawczych npm, plików testowych, certyfikatów/kluczy, danych konta i katalogu node_modules w paczce instalacyjnej.

SHA-256 paczki: `1ecd3963648bd00a1e2acf457c2ccf8d35b9846930d2fe369fef607083ebdc7d`.

## Co obejmują testy

- 50 testów adaptera API na rzeczywistym lokalnym HTTPS: bezpieczne TLS, dopuszczone hosty, dozwolone ścieżki tylko do odczytu, logowanie i wygaśnięcie sesji, rozróżnienie kodów API 305/401, HTTP 401, błędne hasło, limity 407/429 i długie Retry-After, limity rozmiaru/czasu, anulowanie, ścisła walidacja, dokładne Long IDs, stronicowanie i pamięć poprawnych stron przez 24h.
- 19 testów konfiguracji, jednostek, danych brakujących/starych/offline, alarmów, plików lokalnych i platformy z prawdziwymi klasami Homebridge/HAP.
- 1 test gotowej paczki uruchamia Homebridge 1.11.4 i 2.5.0, każdy dwukrotnie, sprawdza przez HTTP/HAP pomiary 3.9 kW, -1100 W i 18.4 kWh, odrzucenie zapisu statusem -70404, zapis pełnych odczytów oraz stałe identyfikatory akcesoriów po restarcie.
- Ten sam zestaw 70 testów przeszedł na Node 24.11.1 i 22.12.0. Nie twierdzimy, że osobno przetestowano każdą wersję Homebridge 2.x lub Node 26.

## Nieudane próby i usunięte problemy

- Pierwsza instalacja narzędzi wykazała 10 zgłoszeń umiarkowanej podatności wynikających z minimatch. Zastosowano wersję 11.0.3 i ponownie zweryfikowano lint/testy; końcowy npm audit nie zgłasza podatności.
- Pierwsze testy integracyjne wykryły zaokrąglanie liczb przez minStep i błędne użycie przeciążenia wyszukującego nazwę usługi zamiast UUID. Oba problemy poprawiono; testy dokładnych wartości i odtworzenia cache przeszły bez osłabiania oczekiwanych pomiarów.
- Test zamknięcia początkowo zakładał ten sam kod wyjścia dla obu Homebridge. Sprawdzono kod obu wersji: 1.11.4 używa kodu 143, 2.5.0 po poprawnym zamknięciu wychodzi z 0. Test sprawdza teraz właściwy kontrakt każdej wersji oraz komunikat obsługi SIGTERM.
- Test null ujawnił zamianę null na [] w pomocniczym serwerze testowym. Poprawiono serwer; produkcyjny adapter odrzuca null i brak pola data, zamiast pokazywać brak alarmów lub usuwać urządzenia.
- Zwykłe uruchomienie lokalnych serwerów testowych było blokowane przez uprawnienia środowiska. Wszystkie końcowe testy HTTPS/HAP wykonano z udostępnionym dostępem do lokalnych portów. Nie wyłączano walidacji TLS klienta produkcyjnego.
- Pierwsza próba końcowego npm pack zakończyła się EPERM przy zapisie domyślnej pamięci npm. Powtórzenie z osobną pamięcią w /private/tmp zakończyło się powodzeniem. Nie zmieniano uprawnień katalogu użytkownika.

## Pozostała weryfikacja u użytkownika

Nie sprawdzono połączenia z rzeczywistym kontem Huawei, odpowiedzi konkretnego SUN2000-10KTL-M1-HC ani prezentacji własnych charakterystyk na fizycznym iPhonie w Controller/Apple Dom. Nie podawano ani nie pobierano prawdziwych danych logowania. Konieczny jest lokalny test po instalacji z właściwym adresem regionalnym.

Nie wykonano audytu AXE natywnej aplikacji Controller/Apple Dom ani ręcznego audytu VoiceOver. Plugin dostarcza schemat konfiguracji dla istniejącego interfejsu Homebridge; nie deklarujemy weryfikacji WCAG całych zewnętrznych aplikacji.

API jest chmurowe, zwykle z około 5-minutowym cyklem danych. Alarmy odczytywane są co 30 minut. W HomeKit mieści się 20 bieżących alarmów, teksty są skracane do 256 bajtów; lokalny plik zawiera cały zwalidowany zestaw. Nie ma sterowania, OAuth, Modbus ani historycznej bazy szeregów czasowych. Kierunek mocy licznika nie jest zgadywany.

Raport dotyczy paczki przygotowanej 7 listopada 2026. W chwili jej weryfikacji projekt nie był repozytorium Git i nie był opublikowany w npm/GitHub. Późniejsze utworzenie prywatnego repozytorium źródeł na GitHubie zlecono osobno; nie zmienia ono opisanych wyników testów ani ograniczeń. Nie zmieniano działającej instalacji Homebridge użytkownika.
