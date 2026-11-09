pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
        // SDK PlugPag do PagBank (mesmo repositório usado pelo app W9 Smart PagBank do Tchê Vendas).
        maven { setUrl("https://raw.githubusercontent.com/pagseguro/PlugPagServiceWrapper/master") }
    }
}

rootProject.name = "TcheFoodAndroid"
include(":app")
