# Huawei FusionSolar Monitor dla Homebridge

Plugin udostępnia odczyty z chmury Huawei FusionSolar przez HomeKit. Wersja 0.1.1 jest przeznaczona przede wszystkim do domowego falownika SUN2000 i licznika energii. Nie wymaga magazynu energii. Niczego nie włącza, nie wyłącza ani nie zmienia ustawień instalacji.

Pełny zestaw pomiarów jest przeznaczony do **Controller for HomeKit**. Eve nie jest wymagana. Apple Dom pokazuje standardowe czujniki, ale nie zapewnia pełnego widoku dowolnych pomiarów elektrycznych. Wygląd i obsługę własnych charakterystyk trzeba sprawdzić w używanej wersji Controller na telefonie; nie są one osobnym ekranem graficznym dodawanym do Apple Dom.

## Wymagania

- Działający Homebridge 1.11.4 lub 2.x. Lokalne testy obejmują dokładnie 1.11.4 i 2.5.0.
- Node.js 22.12+, 24.x albo 26.x zgodnie z wymaganiami swojej wersji Homebridge. Do Homebridge 1 użyj Node 22/24; Homebridge 1.11.4 nie deklaruje obsługi Node 26.
- Osobny login i hasło **Northbound/OpenAPI**, z uprawnieniami Basic APIs i przypisaną instalacją. Login aplikacji FusionSolar nie wystarcza.
- Właściwy adres regionalnego serwera FusionSolar. Przykład `eu5` poniżej nie oznacza, że Twoje konto znajduje się właśnie tam.
- Dostęp serwera Homebridge do Internetu po HTTPS. To integracja chmurowa, nie lokalny Modbus.

## Automatyczne wydania

Każdy push na `main` uruchamia [Build and release](https://github.com/Buslowicz/homebridge-huawei-fusionsolar-monitor/actions/workflows/release.yml). Akcja instaluje zależności z pliku blokady, sprawdza typy i lint, buduje projekt, uruchamia wszystkie testy i audyt zależności. Po powodzeniu publikuje [GitHub Release](https://github.com/Buslowicz/homebridge-huawei-fusionsolar-monitor/releases) z gotowym plikiem `.tgz` i `SHA256SUMS`. Widoczność wydań wynika z ustawień repozytorium; workflow nie zmienia jego widoczności.

Pierwsze wydanie korzysta z wersji bazowej `package.json` (obecnie `0.1.1`). Następne automatycznie zwiększają numer patch względem najwyższego stabilnego tagu, np. `0.1.2`, `0.1.3`. Podniesienie wersji bazowej w źródłach pozwala rozpocząć nową serię minor/major. Wersja paczki jest ustawiana tylko w środowisku budowania; akcja nie dopisuje commitów z numerami wersji do `main`.

Tag wskazuje dokładny sprawdzony commit. Ponowienie akcji dla tego samego commitu używa tego samego numeru i weryfikuje już opublikowane pliki, zamiast je nadpisywać. Publikacja odbywa się po przesłaniu kompletnej paczki i sumy kontrolnej; po nieudanej próbie może pozostać tag lub szkic wydania, który następne uruchomienie może dokończyć. Kolejka przetwarza wydania pojedynczo i mieści do 100 oczekujących uruchomień zgodnie z limitem GitHub Actions.

Akcję można też uruchomić ręcznie przez **Actions → Build and release → Run workflow** na `main`. Korzysta z wbudowanego `GITHUB_TOKEN`; dodatkowe sekrety nie są wymagane. Etap testów ma uprawnienia tylko do odczytu repozytorium, a prawo publikacji otrzymuje osobny etap pracujący na gotowej paczce.

## Instalacja z gotowej paczki (zalecana)

Pobierz paczkę `.tgz` z [najnowszego wydania](https://github.com/Buslowicz/homebridge-huawei-fusionsolar-monitor/releases/latest), przenieś ją na urządzenie Homebridge i w terminalu jego środowiska wykonaj polecenie z nazwą pobranego pliku, na przykład:

```sh
npm install -g /pełna/ścieżka/homebridge-huawei-fusionsolar-monitor-0.1.1.tgz
```

Gotowa paczka zawiera pliki startowe i nie wymaga budowania kodu na Raspberry Pi. Opcja `-g` instaluje ją globalnie, w miejscu przeszukiwanym przez standardową instalację Homebridge. Używaj tego samego środowiska Node/npm i sposobu instalowania co dla pozostałych pluginów. Jeśli usługa działa z własnym katalogiem pluginów, zainstaluj paczkę do tego katalogu zgodnie z konfiguracją swojej usługi.

Jeśli wcześniej zainstalowałeś wersję 0.1.0 lokalnie z GitHuba, usuń tę kopię, wykonując w **tym samym katalogu, w którym była instalowana**:

```sh
npm uninstall homebridge-huawei-fusionsolar-monitor
```

Następnie zainstaluj gotową paczkę i zrestartuj Homebridge w jego panelu. Nie trzeba usuwać konfiguracji Huawei ani parowania akcesoriów.

### Alternatywa: instalacja lokalna ze źródeł GitHuba

Jeśli repozytorium jest prywatne, Git na urządzeniu Homebridge musi mieć uprawnienia do jego odczytu. Tej metody używaj w katalogu projektu, którego `node_modules` jest skonfigurowanym katalogiem pluginów Twojej usługi Homebridge:

```sh
npm install github:Buslowicz/homebridge-huawei-fusionsolar-monitor
```

Samo uruchomienie tego polecenia w dowolnym katalogu domowym nie sprawi, że Homebridge odnajdzie plugin. Jeśli nie znasz katalogu pluginów swojej usługi, użyj gotowej paczki i standardowej instalacji globalnej opisanej powyżej.

Wersja 0.1.1 dodaje automatyczne budowanie przez skrypt `prepare` przy instalacji z GitHuba. Nie używaj `--ignore-scripts` dla instalacji ze źródeł: repozytorium nie przechowuje katalogu `dist`, a ten skrypt tworzy plik startowy pluginu. Narzędzia budowania są instalowane tymczasowo; końcowy plugin nie zawiera kopii Homebridge ani zależności deweloperskich.

Nie zalecamy `npm install -g github:...`: podczas testów npm 11.6.2 i 11.16.0 przekazywał tryb globalny do przygotowania zależności Git, zostawiając link do usuwanego katalogu tymczasowego. Dla instalacji globalnej użyj gotowego pliku `.tgz`. To ograniczenie dotyczy ścieżki instalowania z Git, nie działania pluginu po poprawnej instalacji.

W Dockerze plik i polecenie muszą znajdować się w kontenerze Homebridge albo w jego dostępnym wolumenie. Plugin instaluj tym samym sposobem i w tym samym środowisku co pozostałe pluginy swojej instalacji. Nie trzeba instalować narzędzi programistycznych ani zależności do testów.

W konfiguracji pluginu w Homebridge uzupełnij serwer, login i hasło API, zapisz ustawienia i uruchom Homebridge ponownie. Zalecane jest uruchomienie jako osobny Child Bridge. Jeśli użyjesz Child Bridge, dodaj go do Apple Dom zgodnie z instrukcjami Homebridge.

Przykładowy wpis do tablicy `platforms` w `config.json`:

```json
{
  "platform": "HuaweiFusionSolarMonitor",
  "name": "Huawei FusionSolar",
  "baseUrl": "https://eu5.fusionsolar.huawei.com",
  "username": "TWOJ_LOGIN_NORTHBOUND",
  "password": "UZUPELNIJ_LOKALNIE",
  "pollIntervalSeconds": 300,
  "alarms": true,
  "statusSensors": true,
  "writeSnapshot": true
}
```

Hasło wpisane w interfejsie Homebridge jest przechowywane w jego pliku konfiguracji. Alternatywnie pomiń `username` i `password`, a ustaw `FUSIONSOLAR_USERNAME` i `FUSIONSOLAR_PASSWORD` w środowisku **usługi Homebridge**. Zmienne ustawione tylko w osobnym terminalu nie muszą być widoczne dla usługi. Nie przesyłaj tych danych w czacie ani nie umieszczaj w zgłoszeniach błędów.

## Co zobaczysz

Plugin wykrywa instalacje i urządzenia przypisane do konta. Tworzy akcesorium instalacji, akcesorium falownika, akcesorium licznika oraz opcjonalne akcesorium aktywnych alarmów. Każde akcesorium ma grupy `Huawei pomiary 1` itd. Grupowanie jest technicznym podziałem HomeKit; numery grup nie są numerami faz ani paneli.

W Controller for HomeKit otwórz szczegóły akcesorium i jego charakterystyki. Własne charakterystyki można nazwać i wykorzystać w automatyzacjach zgodnie z możliwościami aplikacji. Opisy zawierają jednostki, np. `Moc czynna [kW]`, `Napięcie fazy A [V]`. Niektóre wersje aplikacji mogą wymagać nadania własnego aliasu charakterystyce. Brak danych w HomeKit jest sygnalizowany jako błąd odczytu/niedostępność, a nie jako pomiar równy zero.

| Źródło | Udostępniane dane, jeśli Huawei je zwraca |
| --- | --- |
| Instalacja | Produkcja dzienna, miesięczna i całkowita; dzienne zużycie; energia oddana do sieci; przychody; stan instalacji |
| SUN2000, typ 38 lub 1 | Moc AC/DC i bierna, napięcia/prądy faz i wejść PV, częstotliwość, sprawność, temperatura wewnętrzna, energia dzienna/całkowita i MPPT, stan i czasy uruchomienia/wyłączenia |
| Licznik, typ 17 lub 47 | Moc sumaryczna i fazowa, napięcia i prądy, współczynnik mocy, liczniki energii dodatniej/ujemnej oraz pozostałe dostępne KPI |
| Alarmy | Liczba alarmów, liczby według ważności oraz nazwy, kody, czas, przyczyny i zalecenia dla maksymalnie 20 bieżących alarmów w HomeKit |
| Pozostałe obsługiwane typy | Wszystkie skalarne KPI zwrócone przez API: EMI 10, bateria 39, ESS 41, SmartAssistant 23070; bez zapewnienia opisów/jednostek dla wszystkich ich pól |

Nowe nieznane skalarne pola API również są udostępniane pod nazwą opartą na oryginalnym kluczu. Ich jednostki nie są zgadywane. Nie wszystkie pola dokumentacji muszą być obsługiwane przez model lub firmware urządzenia. `null`, puste wartości i `N/A` nie są udostępniane jako fikcyjne zera. Fizycznie nieistniejące wejścia PV mogą być pominięte przez Huawei albo zwracać zero; plugin zachowuje to rozróżnienie.

Ważne: `active_power` falownika ma w tym API jednostkę **kW**, natomiast licznika typu 17/47 **W**. Znak mocy licznika jest zachowany. Plugin nie wylicza chwilowego zużycia domu z niepotwierdzonego kierunku licznika i nie zmienia nazw liczników energii dodatniej/ujemnej na import/eksport bez potwierdzenia sposobu podłączenia. Pole `day_use_energy` jest gotowym dziennym zużyciem udostępnianym przez Huawei. Waluta przychodów jest ustawiona w FusionSolar, nie zakłada się PLN.

### Wybrane dane w Apple Dom

- Temperatura wewnętrzna falownika jako czujnik temperatury. To temperatura urządzenia, nie pomieszczenia.
- Opcjonalny wirtualny czujnik kontaktowy `Produkcja PV Huawei`: stan otwarty oznacza dodatnią moc AC, zamknięty oznacza brak dodatniej mocy. To wskaźnik produkcji, nie sterowanie.
- Opcjonalny wirtualny czujnik kontaktowy `Usterka instalacji Huawei`: otwarty oznacza zgłoszoną usterkę lub rozłączenie instalacji, zamknięty oznacza stan zdrowy według Huawei. Nie zastępuje listy alarmów.

Wszystkie te odczyty są tylko do odczytu. Automatyzacje zmieniające inne akcesoria domowe uruchamiasz na podstawie danych odczytanych przez plugin. Nie oznacza to sterowania samym falownikiem.

## Odświeżanie, brak połączenia i alarmy

- Dane bieżące: co najmniej co 300 sekund od **zakończenia** poprzedniego cyklu. Wydłużenie jest możliwe do 3600 sekund. Huawei zbiera dane urządzeń minimum co 5 minut, więc plugin nie służy do automatyzacji wymagających reakcji w sekundach.
- Aktywne alarmy: co 30 minut. Zapytanie obejmuje czas od epoki Unix do teraz, żeby nie zgubić starszego nadal aktywnego alarmu. Nie jest to historia alarmów skasowanych.
- Lista instalacji i urządzeń: przy uruchomieniu, potem co 24 godziny. Po błędzie wykrywania ponowna próba następuje najwcześniej za godzinę. Zmiana uprawnień lub poprawienie konfiguracji może wymagać ponownego uruchomienia.
- Sesja API jest współdzielona wewnątrz pluginu i używana do 30 minut. Nie ma osobnego logowania dla każdego pomiaru. Po błędnych danych logowania plugin odczekuje 30 minut.
- Każda próba danego odczytu zużywa lokalny limit, także gdy zakończy się błędem. Kod 305/HTTP 401 unieważnia sesję; plugin może ją odnowić, ale odczyt czeka na następny dozwolony cykl. Kod API 401 oznacza brak uprawnień, nie potrzebę ciągłego ponawiania logowania.
- Limity 407/429 i `Retry-After` wydłużają odstęp. Nie uruchamiaj kilku kopii ani innych integracji na tym samym koncie API bez uwzględnienia ich wspólnych limitów. Ograniczenia dzienne są zależne od zasobów konta; nie restartuj pluginu wielokrotnie w krótkim czasie.
- Nieudany odczyt oznacza daną grupę jako niedostępną; pozostałe grupy mogą nadal działać. Po przekroczeniu wieku `2 × interwał + 60 sekund` dane bieżące przestają być dostępne. Dla alarmów próg to 61 minut. Po restarcie nie pokazuje się zapisanych wcześniej wartości jako aktualnych.
- Jeśli Huawei jawnie zgłosi rozłączenie urządzenia/licznika, jego stare pomiary elektryczne przestają być dostępne w HomeKit; stan połączenia pozostaje widoczny. Plugin nie zna rzeczywistego czasu każdego pomiaru, jeśli Huawei go nie zwraca.

`Dane odebrano z API` oznacza czas otrzymania odpowiedzi przez plugin. Nie jest to potwierdzony czas wykonania pomiaru przez falownik.

## Pełny lokalny zestaw odczytów

Przy `writeSnapshot: true` aktualny plik JSON znajduje się w:

```text
<folder danych Homebridge>/huawei-fusionsolar-monitor/<identyfikator>.json
```

Plik zawiera metadane urządzeń, wszystkie zwrócone i zwalidowane KPI, pełne opisy wszystkich alarmów oraz czas i stan ostatniego odczytu każdego źródła. `available` oznacza powodzenie ostatniego odczytu danego API, a nie gwarancję, że fizyczne urządzenie jest online. Przy błędzie pozostają poprzednie dane z `available: false` i poprzednią datą odbioru.

Hasło, token sesji, adres instalacji, geolokalizacja i dane kontaktowe konta nie są zapisywane. Nazwy instalacji, identyfikatory i numery seryjne pozostają danymi prywatnymi; sprawdź plik przed jego udostępnieniem. Katalog jest tworzony z uprawnieniami 700, pliki z 600. Plugin nie uruchamia dodatkowego serwera WWW. Plik zawiera tylko ostatni zestaw danych, nie wielomiesięczną historię.

HomeKit ogranicza długość tekstu; opisy alarmów w Controller są skracane do 256 bajtów UTF-8. Pełny opis (do limitu walidacji API) jest w pliku lokalnym. Maksymalnie 20 alarmów w HomeKit jest sortowanych według ważności, następnie od najnowszego. Ich numer oznacza pozycję na aktualnej liście, a nie stały identyfikator zdarzenia. Więcej alarmów pozostaje dostępnych w lokalnym zestawie.

## Tryb demonstracyjny

Bez połączenia z Huawei można sprawdzić dodanie akcesoriów i wygląd pomiarów:

```json
{
  "platform": "HuaweiFusionSolarMonitor",
  "name": "Huawei DEMO",
  "demo": true,
  "writeSnapshot": true
}
```

Nazwy zawierają `Symulacja`, a log wyraźnie wskazuje tryb DEMO. Po przejściu na prawdziwe konto tworzone są inne akcesoria; akcesoria demo są usuwane po poprawnym wykryciu instalacji. Nie używaj danych demo do rzeczywistych automatyzacji.

## Rozwiązywanie problemów

| Komunikat | Co sprawdzić |
| --- | --- |
| `authentication`, 20400 | Osobne konto Northbound, hasło, blokada/ważność konta, właściwy serwer regionalny; nie ponawiaj prób wielokrotnie |
| `permission (401)` | Uprawnienia Basic APIs i przypisanie konta do instalacji, ewentualnie uprawnienia konkretnego API alarmów |
| `rate-limit`, 407/429 | Poczekaj; wyłącz inne kopie korzystające z tego samego konta lub użyj osobnego konta API |
| `network` | Internet, DNS, certyfikat HTTPS i adres regionu; plugin nie wyłącza kontroli certyfikatów |
| `invalid-response` | Nieoczekiwany format/typ/zakres danych, nieobsługiwany kod API albo niezgodna wersja platformy; sprawdź lokalny stan bez publikowania hasła i tokenu |
| `No plugin was found for the platform "HuaweiFusionSolarMonitor"` | Homebridge nie załadował pluginu. Sprawdź wcześniejszy komunikat `ERROR LOADING PLUGIN`, użyj wersji co najmniej 0.1.1 dla instalacji z GitHuba i upewnij się, że plugin jest zainstalowany w katalogu przeszukiwanym przez usługę. `npm list -g --depth=0 homebridge-huawei-fusionsolar-monitor` sprawdza kopię globalną w bieżącym środowisku npm. |
| Puste pola | Urządzenie może nie udostępniać danego KPI; sprawdź typ urządzenia, uprawnienia i to, czy dane istnieją w FusionSolar |
| Brak W/kWh w Apple Dom | Użyj widoku charakterystyk w Controller for HomeKit; plugin nie może dowolnie zmienić interfejsu Apple Dom |

Jeżeli konto obejmuje wiele instalacji, dodaj opcjonalne `stationCodes: ["NE=..."]`. Użyj identyfikatorów zwróconych przez API, ponieważ mogą różnić się od identyfikatora w interfejsie FusionSolar. Maksymalny zakres tej wersji to 100 wybranych instalacji, 100 urządzeń każdego typu i 1000 instalacji na etapie listowania konta (10 stron). To plugin domowy; nie integracja do masowego zarządzania farmami.

## Budowanie i weryfikacja źródeł

```sh
npm ci
npm run verify
npm audit
npm pack
```

Testy API uruchamiają prawdziwy lokalny serwer HTTPS z osobnym certyfikatem testowym. Klucz w `tests/fixtures` dotyczy wyłącznie localhost i nie jest pakowany do pluginu. Testy Homebridge uruchamiają odizolowany bridge demonstracyjny, używają wyłącznie lokalnych portów i nie kontaktują się z Huawei. W niektórych środowiskach wymagane jest zezwolenie na lokalne nasłuchiwanie.

Testy instalacji wymagają Git i npm: sprawdzają rzeczywistą lokalną zależność Git oraz globalną instalację gotowej paczki. Używają pamięci npm wskazanej przez `FUSIONSOLAR_TEST_NPM_CACHE` albo `npm_config_cache`; przy pustej pamięci potrzebny jest dostęp do rejestru npm. Wyniki i ograniczenie globalnej instalacji Git opisano w [raporcie poprawki 0.1.1](docs/installation-fix.md).

Plugin nie ma zależności wykonawczych npm. Narzędzia TypeScript/ESLint i dwie wersje Homebridge są zależnościami wyłącznie do budowania/testów. Nadpisanie `minimatch` do 11.0.3 usuwa zgłoszoną podatność narzędzi deweloperskich; działanie narzędzi jest objęte weryfikacją.

## Podstawa i ograniczenia weryfikacji

Kontrakty opracowano na podstawie dostarczonego dokumentu **SmartPVMS 26.1.0 NBI Reference, Issue 01, 2026-03-30**: rozdziały 3.2 (konto API), 4.2 (limity), 5.1.1 (wykrywanie), 5.1.2 (KPI), 5.1.3 (aktywne alarmy), 6.1 (błędy). Dokument Huawei nie jest rozpowszechniany w paczce.

Oficjalne źródła implementacji HomeKit: [szablon Homebridge](https://github.com/homebridge/homebridge-plugin-template), [HAP-NodeJS](https://github.com/homebridge/HAP-NodeJS), [obsługa własnych charakterystyk w Controller](https://controllerforhomekit.wordpress.com/features/vendor-characteristics/).

Testy lokalne i demonstracja nie potwierdzają jeszcze poprawnej odpowiedzi Twojego konta Huawei, zgodności firmware konkretnego SUN2000-10KTL-M1-HC ani wyglądu danych w Twojej wersji Controller/iOS. Te trzy rzeczy wymagają sprawdzenia po instalacji. Nie zaimplementowano sterowania, OAuth, Modbus ani pobierania historycznych szeregów czasowych. Dzienne/miesięczne/całkowite liczniki obejmują to, co zwraca bieżące API; nie jest to kopia całej funkcjonalności aplikacji FusionSolar.
