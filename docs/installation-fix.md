# Poprawka instalacji 0.1.1

Użytkownik zgłosił brak platformy HuaweiFusionSolarMonitor po `npm install github:Buslowicz/homebridge-huawei-fusionsolar-monitor` na Raspberry Pi (Homebridge 2.5.0, Node 26.13.0).

Przyczynę po stronie pluginu odtworzono: instalacja lokalnej zależności Git z oryginalnym manifestem 0.1.0 kończyła się powodzeniem, ale brakowało `dist/index.js`. Repozytorium przechowuje źródła TypeScript. Skrypt `prepack` budował paczkę przy `npm pack`, natomiast pakowanie zależności Git przez npm wywołuje `prepare`.

Zmiana w 0.1.1 zastępuje `prepack` skryptem `prepare: npm run build`. Logika odczytów Huawei i akcesoriów nie uległa zmianie. Gotowa paczka nadal zawiera skompilowane pliki i nie instaluje narzędzi deweloperskich na urządzeniu Homebridge.

## Regresja przed poprawką

Rzeczywista instalacja lokalnej zależności Git z oryginalnym manifestem, bez `dist` i bez `node_modules` w źródłach:

```text
tests 1
pass 0
fail 1
ENOENT: consumer/node_modules/homebridge-huawei-fusionsolar-monitor/dist/index.js
```

Instalacja npm sama zwracała kod 0; test wykrywał brak uruchamialnego pluginu.

## Końcowa weryfikacja

Na czystym zestawie źródeł w /private/tmp, Node.js 24.11.1 (npm 11.6.2), z zależnościami z pliku blokady:

```text
npm run verify
> npm run typecheck && npm run lint && npm run build && npm test

tsc -p tsconfig.json --noEmit
exit 0
eslint src
exit 0
tsc -p tsconfig.json
exit 0

✔ a clean local Git dependency install builds the runtime and registers its platform without bundled development dependencies
✔ the prebuilt archive installs globally and registers its platform without installing build tools
✔ installable archive loads in real Homebridge 1/2, publishes precise read-only data, then restores cache
tests 72
pass 72
fail 0
cancelled 0
skipped 0
```

Dodatkowo obie ścieżki instalacji sprawdzono na Node.js 26.3.1 z npm 11.16.0:

```text
node --test tests/git-install.test.mjs
tests 2
pass 2
fail 0
cancelled 0
skipped 0
```

Nie oznacza to fizycznego testu Raspberry Pi ani osobnego sprawdzenia dokładnie Node 26.13.0 użytkownika.

Test Git tworzy prawdziwe tymczasowe repozytorium z rzeczywistymi źródłami pluginu, wykonuje npm install, importuje zainstalowany plik startowy i sprawdza rejestrację platformy przez API Homebridge. Drugi test wykonuje rzeczywiste npm install --global gotowej paczki do odizolowanego katalogu. Oba sprawdzają brak kopii Homebridge, TypeScript i innych zależności budowania w katalogu wykonawczym. Nie korzystają z konta Huawei.

Audyt niezmienionego drzewa zależności:

```text
npm audit --json --cache /private/tmp/fusionsolar-npm-cache
"vulnerabilities": {}
"total": 0
```

## Dlaczego zalecamy gotową paczkę do instalacji globalnej

Dodatkowo zbadano instalację `npm install -g git+file://...` przy npm 11.6.2 i 11.16.0. npm przekazywał tryb globalny i docelowy prefix do wewnętrznego przygotowania repozytorium Git. Skutkiem był brak lokalnego tsc, a po diagnostycznym wymuszeniu lokalnego npm ci pozostawał link do tymczasowego klonu usuwanego po zakończeniu instalacji. Samo npm mogło zwrócić powodzenie mimo uszkodzonej instalacji. Próba z wymuszonym ci nie została włączona do pluginu.

Nie przedstawiamy globalnej instalacji bezpośrednio z Git jako naprawionej. Obsługiwane i sprawdzone ścieżki to lokalna instalacja źródeł Git do katalogu przeszukiwanego przez Homebridge oraz globalna instalacja gotowej paczki .tgz. Ta druga jest zalecana na Raspberry Pi. Testy końcowe nie pomijają speców ani nie oznaczają nieudanej globalnej instalacji Git jako zaliczonej.

Zmiana dotyczy instalatora. Wyświetlanie danych na fizycznym Raspberry Pi/iPhonie i dostęp do prawdziwego konta Huawei nadal wymagają sprawdzenia w środowisku użytkownika.
