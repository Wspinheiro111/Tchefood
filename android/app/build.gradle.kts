plugins {
    id("com.android.application")
}

// Sem TCHEFOOD_APP_URL o APK leva o Tchê Food embutido (build do Vite em ../dist) e funciona offline.
// Com TCHEFOOD_APP_URL=https://... o APK abre o sistema publicado nesse endereço (atualiza sem reinstalar).
val appUrl = providers.gradleProperty("TCHEFOOD_APP_URL").orNull?.trim()?.trimEnd('/').orEmpty()
if (appUrl.isNotEmpty() && !appUrl.startsWith("https://")) {
    throw GradleException("TCHEFOOD_APP_URL precisa ser https:// (as pontes de pagamento não podem ficar expostas a http)")
}
val bundleWebApp = appUrl.isEmpty()
val webDist = rootProject.layout.projectDirectory.dir("../dist")
val webAssetsRoot = layout.buildDirectory.dir("generated/webapp")

// Versão: o Android só instala por cima um APK com versionCode maior ou igual ao instalado, então o número
// sobe sozinho a cada commit (quantidade de commits até o HEAD). TCHEFOOD_VERSION_CODE substitui a contagem.
// Clone raso (--depth) daria um número menor que o real: aí o build para, em vez de gerar um APK que não instala.
fun git(vararg args: String): String =
    providers.exec {
        commandLine("git", "-C", rootProject.projectDir.parentFile.absolutePath, *args)
    }.standardOutput.asText.get().trim()

val versionCodeOverride = providers.gradleProperty("TCHEFOOD_VERSION_CODE").orNull?.trim().orEmpty()
val appVersionCode: Int = if (versionCodeOverride.isNotEmpty()) {
    versionCodeOverride.toIntOrNull()?.takeIf { it in 1..2_100_000_000 }
        ?: throw GradleException("TCHEFOOD_VERSION_CODE precisa ser um número inteiro de 1 a 2100000000")
} else {
    val shallow = try { git("rev-parse", "--is-shallow-repository") } catch (e: Exception) {
        throw GradleException("não consegui ler o git para numerar a versão; rode dentro do repositório ou passe -PTCHEFOOD_VERSION_CODE=N", e)
    }
    if (shallow == "true") {
        throw GradleException("clone raso do git: a contagem de commits sairia menor que a real. Rode `git fetch --unshallow` ou passe -PTCHEFOOD_VERSION_CODE=N")
    }
    git("rev-list", "--count", "HEAD").toInt()
}
val appCommit: String = try { git("rev-parse", "--short=7", "HEAD") } catch (e: Exception) { "sem-git" }
val appVersionName = "0.1.$appVersionCode-$appCommit"

// Assinatura de release: a chave nunca fica no repositório. Arquivo e senhas vêm de propriedades do Gradle
// (o build-apk.sh passa as senhas pelo ambiente, ORG_GRADLE_PROJECT_*, nunca na linha de comando).
// Sem a chave, só o build de release falha; o debug continua como antes.
val keystorePath = providers.gradleProperty("TCHEFOOD_KEYSTORE_FILE").orNull?.trim().orEmpty()
val keystorePassword = providers.gradleProperty("TCHEFOOD_KEYSTORE_PASSWORD").orNull.orEmpty()
val releaseKeyAlias = providers.gradleProperty("TCHEFOOD_KEY_ALIAS").orNull?.trim().orEmpty()
val releaseKeyPassword = providers.gradleProperty("TCHEFOOD_KEY_PASSWORD").orNull.orEmpty()
val releaseSigningReady = keystorePath.isNotEmpty() && keystorePassword.isNotEmpty() &&
    releaseKeyAlias.isNotEmpty() && releaseKeyPassword.isNotEmpty()

android {
    namespace = "food.tche.smartpos"
    compileSdk = 34

    defaultConfig {
        applicationId = "food.tche.smartpos"
        minSdk = 25
        targetSdk = 34
        versionCode = appVersionCode
        versionName = appVersionName
        buildConfigField("String", "TCHEFOOD_APP_URL", "\"$appUrl\"")
    }

    signingConfigs {
        if (releaseSigningReady) {
            create("tchefood") {
                val file = rootProject.file(keystorePath)
                if (!file.isFile) throw GradleException("TCHEFOOD_KEYSTORE_FILE não existe: $keystorePath")
                storeFile = file
                storePassword = keystorePassword
                keyAlias = releaseKeyAlias
                keyPassword = releaseKeyPassword
            }
        }
    }

    // pagbank: Moderninha Smart / SmartPOS PagBank, cobra pelo PlugPag dentro da máquina.
    // tablet: celular ou tablet Android comum, cobra pela nuvem (Stone Connect, Mercado Pago Point).
    flavorDimensions += "device"
    productFlavors {
        create("pagbank") {
            dimension = "device"
            manifestPlaceholders["appLabel"] = "Tchê Food"
        }
        create("tablet") {
            dimension = "device"
            applicationIdSuffix = ".tablet"
            manifestPlaceholders["appLabel"] = "Tchê Food"
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            if (releaseSigningReady) signingConfig = signingConfigs.getByName("tchefood")
        }
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    sourceSets["main"].assets.srcDir(webAssetsRoot)
}

val copyWebApp by tasks.registering(Copy::class) {
    description = "Copia o build web do Tchê Food (dist/) para os assets do APK em www/."
    enabled = bundleWebApp
    from(webDist)
    into(webAssetsRoot.map { it.dir("www") })
    doFirst {
        if (!webDist.file("index.html").asFile.exists()) {
            throw GradleException("Falta dist/index.html: rode `npm run build` na raiz do projeto antes do build do APK")
        }
    }
}

// Release sem a chave nunca sai como APK sem assinatura (que não instala) nem com a chave de debug.
tasks.matching { it.name.startsWith("assemble") && it.name.endsWith("Release") || it.name.startsWith("package") && it.name.endsWith("Release") }
    .configureEach {
        doFirst {
            if (!releaseSigningReady) {
                throw GradleException("release precisa da chave do Tchê Food: TCHEFOOD_KEYSTORE_FILE, TCHEFOOD_KEYSTORE_PASSWORD, TCHEFOOD_KEY_ALIAS e TCHEFOOD_KEY_PASSWORD (veja docs/apk-release.md)")
            }
        }
    }

tasks.named("preBuild") { dependsOn(copyWebApp) }
tasks.matching { it.name.startsWith("merge") && it.name.endsWith("Assets") }.configureEach { dependsOn(copyWebApp) }

dependencies {
    implementation("androidx.webkit:webkit:1.11.0")
    implementation("androidx.annotation:annotation:1.8.0")
    "pagbankImplementation"("br.com.uol.pagseguro.plugpagservice.wrapper:wrapper:1.35.0")
}
